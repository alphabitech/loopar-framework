import jwt from 'jsonwebtoken';
import { loopar } from '../loopar.js';
import { CSRF_COOKIE_NAME, generateCsrfToken } from './csrf.js';
import { getRequest, getTenant } from '../server/router/request-context.js';

const getJWTSecret = () => loopar.jwtSecret;
const REFRESH_THRESHOLD = 1800;
/** Same lifetime as JWT login (1d); readable by JS for header + double-submit check. */
const CSRF_COOKIE_MS = 24 * 60 * 60 * 1000;

function setCsrfCookie(token) {
  if (!token) return;
  loopar.cookie.set(CSRF_COOKIE_NAME, token, {
    httpOnly: false,
    path: '/',
    maxAge: CSRF_COOKIE_MS,
  });
}

export default class Auth {
  #disabledCache = new Map();
  #disabledHookBound = false;

  constructor(tenantId, getUser) {
    this.tenantId = tenantId;
    this.tokenName = `loopar_token_${tenantId}`;
    this.loggedCookieName = `logged_${tenantId}`;
  }

  #bindDisabledInvalidation() {
    if (this.#disabledHookBound) return;
    this.#disabledHookBound = true;
    const drop = ({ doc }) => { this.#disabledCache.delete(doc?.name); this.#disabledCache.delete(doc?.email); };
    loopar.hook("User", "afterSave", drop);
    loopar.hook("User", "afterDelete", drop);
  }

  async disabledUser(user_id) {
    if ((!loopar.__installed__ || loopar.installing) || (user_id === "Administrator")) return false;

    this.#bindDisabledInvalidation();
    if (this.#disabledCache.has(user_id)) return this.#disabledCache.get(user_id);

    const status = await loopar.db.query('User').where({ name: user_id }).orWhere({ email: user_id })
      .select('disabled').first();

    const disabled = !status || status.disabled === 1 || status.disabled === '1';
    this.#disabledCache.set(user_id, disabled);
    return disabled;
  }

  async getUser(user_id=null) {
    if (!loopar.__installed__ && loopar.installing) {
      return {
        name: "Administrator"
      }
    }

    return await loopar.db.query('User').where({ name: user_id }).orWhere({ email: user_id })
      .select('name', 'email', 'password', 'disabled', 'profile_picture').first();
  }

  authUser() {
    try {
      const token = loopar.cookie.get(this.tokenName);
      if (!token) return null;
      
      return jwt.verify(token, getJWTSecret());
    } catch (error) {
      console.error(['[Auth.authUser] Error:', error.message]);
      return null;
    }
  }

  async killSession(res) {
    const optsExpire = { httpOnly: true, path: '/', expires: new Date(0) };

    try {
      if (loopar.cookie && typeof loopar.cookie.remove === 'function') {
        await loopar.cookie.remove(this.tokenName).catch(() => {});
        await loopar.cookie.remove(this.loggedCookieName).catch(() => {});
      }
    } catch (e) {}

    try {
      if (res && loopar.cookie && typeof loopar.cookie.remove === 'function') {
        await loopar.cookie.remove(res, this.tokenName).catch(() => {});
        await loopar.cookie.remove(res, this.loggedCookieName).catch(() => {});
      }
    } catch (e) {}

    try {
      if (loopar.cookie && typeof loopar.cookie.set === 'function') {
        await loopar.cookie.set(this.tokenName, '', optsExpire).catch(() => {});
        await loopar.cookie.set(this.loggedCookieName, '', optsExpire).catch(() => {});
        if (res) {
          await loopar.cookie.set(res, this.tokenName, '', optsExpire).catch(() => {});
          await loopar.cookie.set(res, this.loggedCookieName, '', optsExpire).catch(() => {});
        }
      }
    } catch (e) {}

    try {
      if (res && typeof res.clearCookie === 'function') {
        res.clearCookie(this.tokenName, { path: '/' });
        res.clearCookie(this.loggedCookieName, { path: '/' });
        res.clearCookie(CSRF_COOKIE_NAME, { path: '/' });
      }
    } catch (e) {}

    try {
      if (loopar.cookie?.remove) {
        loopar.cookie.remove(CSRF_COOKIE_NAME, { path: '/' });
      }
    } catch (e) {}
  }

  async logout() {
    loopar.cookie.remove(this.loggedCookieName);
    return this.killSession();
  }

  user(){
    const req = getRequest();
    if (req && '__authUserName__' in req) return req.__authUserName__;

    const resolve = () => {
      const token = loopar.cookie.get(this.tokenName);
      if (!token) return null;
      try {
        const userData = jwt.verify(token, getJWTSecret(), { ignoreExpiration: true });
        return userData?.name ?? null;
      } catch (error) {
        return null;
      }
    };

    const name = resolve();
    if (req) req.__authUserName__ = name;
    return name;
  }

  async award(award=true) {
    const token = loopar.cookie.get(this.tokenName);
    
    if (!token) return this.killSession();

    try {
      const userData = jwt.verify(token, getJWTSecret(), { ignoreExpiration: true });

      if (!userData) return this.killSession();

      if (award && await this.disabledUser?.(userData?.name)) return this.killSession();

      const now = Math.floor(Date.now() / 1000);
      const exp = userData.exp || 0;

      if (exp - now < REFRESH_THRESHOLD || !userData.csrfToken) {
        const payload = {
          name: userData.name,
          email: userData.email,
          avatar: userData.avatar,
          profile_picture: userData.profile_picture,
          user_type: userData.user_type,
          mfa: !!userData.mfa,
          tenant: this.tenantId,
          csrfToken: userData.csrfToken || generateCsrfToken(),
        };

        const newToken = jwt.sign(payload, getJWTSecret(), { expiresIn: '1d' });
        loopar.cookie.set(this.tokenName, newToken, { httpOnly: true, path: '/' });
        loopar.cookie.set(this.loggedCookieName, '1', { httpOnly: false, path: '/' });
        setCsrfCookie(payload.csrfToken);

        return payload;
      }

      const session = {
        name: userData.name,
        email: userData.email,
        avatar: userData.avatar,
        profile_picture: userData.profile_picture,
        user_type: userData.user_type,
        mfa: !!userData.mfa,
        tenant: userData.tenant || this.tenantId,
        exp: userData.exp,
        iat: userData.iat,
        csrfToken: userData.csrfToken,
      };
      setCsrfCookie(session.csrfToken);
      return session;
    } catch (error) {
      return this.killSession();
    }
  }

  /**
   * On a website domain (tenant `sites`) only Web users may sign in: desk
   * accounts never authenticate there, so its login can't be used to probe
   * or brute-force administrators. Same message as a wrong password — no
   * oracle about which accounts exist or what type they are.
   * Public so a login flow can run it BEFORE a second-factor challenge.
   */
  assertLoginAllowed(user) {
    if (getTenant()?.webApp && user?.user_type !== 'Web') {
      this.killSession();
      loopar.throw({ code: 401, title: 'Login Error', message: 'Invalid user or password' });
    }
  }

  /** `mfa`: the session was opened after a verified second factor. */
  login(user, { mfa = false } = {}) {
    this.assertLoginAllowed(user);

    const payload = {
      name: user.name,
      email: user.email,
      avatar: user.name.substring(0, 1).toUpperCase(),
      profile_picture: user.profile_picture,
      user_type: user.user_type,
      mfa: !!mfa,
      tenant: this.tenantId,
      csrfToken: generateCsrfToken(),
    };
  
    const token = jwt.sign(payload, getJWTSecret(), { expiresIn: '1d' });
  
    loopar.cookie.set(this.tokenName, token, { httpOnly: true, path: '/' });
    loopar.cookie.set(this.loggedCookieName, '1', { httpOnly: false, path: '/' });
    setCsrfCookie(payload.csrfToken);

    return payload;
  }

  validateTenant(userData) {
    if (userData.tenant && userData.tenant !== this.tenantId) {
      console.warn(`[Auth] Token tenant mismatch: expected ${this.tenantId}, got ${userData.tenant}`);
      return false;
    }
    return true;
  }
}