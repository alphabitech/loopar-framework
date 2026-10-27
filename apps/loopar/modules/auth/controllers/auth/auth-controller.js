
'use strict';

import {loopar, BaseController} from 'loopar';
import {validatePasswordResetToken, generatePasswordResetToken, resetPassword} from "./recovery.js"
import {sendPasswordResetEmail} from "./recovery-email.js"
import {getProvider, providerKeys, providerLabel, generateState, generateCodeVerifier} from "./oauth-providers.js"
import {setOauthTx, readOauthTx, clearOauthTx, oauthRedirectUri, loadProviderConfig, parseScopes, linkUser} from "./oauth.js"
import {completeLogin, verifyChallenge, cancelChallenge} from "./mfa.js"

export default class AuthController extends BaseController {
 static actionsEnabled = ['login', 'logout', 'requestReset', 'oauthCallback'];
  // Mutations: never reachable over GET.
  static postOnlyActions = ['mfaVerify', 'mfaCancel'];
  
  constructor(props){
    super(props);
  }

  async publicActionLogin() {
    return await this.#makeAction('Login', async (form) => {
      const user = await form.verifyCredentials();
      const result = await completeLogin(user, { landing: (row) => this.#postLoginDestination(row) });

      if (result.mfa_locked) {
        loopar.throw({
          code: 429,
          title: 'Too many attempts',
          message: 'Too many verification attempts. Try again in a few minutes.',
        });
      }

      // Second factor pending: the client shows the code step.
      if (result.mfa_required) {
        return this.success('Verification required', { mfa_required: true, notify: false });
      }

      return this.#sessionOpened(result.session, this.#postLoginDestination(result.session));
    });
  }

  /**
   * POST /auth/mfaVerify { code } | { recovery_code } — second step of a
   * login whose user has 2FA on. The pending challenge rides a signed cookie
   * set by the first step (password, OAuth or claim).
   */
  async publicActionMfaVerify() {
    const { code, recovery_code } = this.body || {};
    const { session, landing } = await verifyChallenge({ code, recovery_code });
    return this.#sessionOpened(session, landing || this.#postLoginDestination(session));
  }

  /** POST /auth/mfaCancel — "back to sign in" from the code step. */
  async publicActionMfaCancel() {
    cancelChallenge();
    return this.success('ok', { notify: false });
  }

  #sessionOpened(session, destination) {
    // In-place login (web modal): no navigation, the client soft-refreshes.
    if (this.query.inModal || this.req.__WORKSPACE_NAME__ === 'web') {
      return this.success('Welcome', { user: session || null, notify: false });
    }

    // Full-page login: safe return URL if given, else land by user type.
    return this.redirect(destination, { hard: true });
  }

  /** Validated `?redirect=` first, else landing by user type. */
  #postLoginDestination(session) {
    const webLanding = process.env.WEB_LANDING || '/';
    const back = this.#safeReturnUrl(this.query.redirect);
    if (back) return back;
    return session?.user_type === 'Web' ? webLanding : '/desk/Desk/view';
  }

  /** Anti open-redirect: same-origin absolute paths only, never /auth (would loop). */
  #safeReturnUrl(url) {
    if (typeof url !== 'string' || !url) return null;
    if (!url.startsWith('/') || url.startsWith('//')) return null;
    if (url.toLowerCase().startsWith('/auth')) return null;
    return url;
  }

  async publicActionLogout() {
    loopar.auth.logout();

    // POST (web/ajax) → stay on the current page; GET (desk link) → login.
    if (this.method === 'POST') {
      return this.success('Logged out', { notify: false });
    }
    return this.redirect('/auth/login');
  }

  async publicActionRegister() {
    return await this.#makeAction('Register');
  }

  async publicActionRecoveryUser() {
    return await this.#makeAction('Reset User');
  }

  async forgotUsername() {
    const { email } = this.body;
    const { user } = await getUsernameByEmail(email);

    if (user) {
      await sendUsernameReminderEmail(user);
    }

    return this.success('Si el correo existe, recibirás tu nombre de usuario.');
  }

  async publicActionRecoveryPasswordRequest() {
    const self = this;
    return await this.#makeAction('Reset Password Request', async () => {
      const { email } = self.body;
  
      const { ok, user, rawToken } = await generatePasswordResetToken(email);
  
      if (user && rawToken) {
        await sendPasswordResetEmail(user, rawToken);
      }
  
      return `We sent a password reset link to ${email}.`;
    });
  }

  async publicActionRecoveryPassword() {
    return await this.#makeAction('Reset Password', async () => {
      const { token, new_password } = this.body;

      try {
        await resetPassword(token, new_password);
        return this.success('Password reset successful.');
      } catch (e) {
        return this.error(e.message);
      }
    });
  }

  async publicActionValidateResetToken() {
    const { token } = this.query;
    const { valid, reason } = await validatePasswordResetToken(token);

    if (!valid) {
      return { valid: false, reason }
    }

    return  {valid: true }
  }

  /**
   * GET /auth/claim?token=<jwt> — one-time magic-link from the cloud control
   * plane. Verifies the token server→server (CLOUD_VERIFIER_URL +
   * CLOUD_VERIFIER_TOKEN, written to the tenant's .env at provisioning),
   * finds the local user by email and opens a session. Missing env vars =
   * tenant not cloud-provisioned.
   */
  async publicActionClaim() {
    const token = String(this.query?.token || '').trim();
    if (!token) {
      return this.redirect('/auth/login?claim=missing_token');
    }

    const { url: verifierUrl, token: verifierToken } = loopar.cloudVerifier;

    if (!verifierUrl || !verifierToken) {
      console.error('[auth/claim] tenant is not cloud-provisioned (missing CLOUD_VERIFIER_URL / CLOUD_VERIFIER_TOKEN)');
      return this.redirect('/auth/login?claim=not_supported');
    }

    let verifyResp;
    try {
      const r = await fetch(verifierUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Loopar-Tenant-Secret': verifierToken,
          'X-Loopar-Tenant-Id':     loopar.tenantId || '',
        },
        body: JSON.stringify({ token }),
      });
      verifyResp = await r.json();
    } catch (err) {
      // Don't log the JWT — it's user-bound; the URL is enough to debug.
      console.error('[auth/claim] verifier call failed:', err.message, verifierUrl);
      return this.redirect('/auth/login?claim=verifier_unreachable');
    }

    if (!verifyResp?.valid) {
      const reason = encodeURIComponent(verifyResp?.reason || 'invalid');
      return this.redirect(`/auth/login?claim=${reason}`);
    }

    // Usually resolves to `Administrator` (installer sets the customer's email).
    const email = String(verifyResp.email || '').trim().toLowerCase();
    if (!email) {
      return this.redirect('/auth/login?claim=no_email');
    }

    const user = await loopar.db.getDoc('User', { email });
    if (!user) {
      console.warn(`[auth/claim] no User row found for email "${email}"`);
      return this.redirect('/auth/login?claim=user_not_found');
    }

    const result = await completeLogin(user, { landing: '/desk' });
    if (result.mfa_locked) return this.redirect('/auth/login?claim=mfa_locked');
    if (result.mfa_required) return this.redirect('/auth/login?mfa=1');

    // No forced /auth/set-password — the desk banner (must_change_password)
    // and Profile's "Reset by email" cover it.
    return this.redirect('/desk', { hard: true });
  }

  /**
   * POST /auth/requestReset (authenticated) — Profile's "Reset by email"
   * button; no current password needed. Always answers success to avoid
   * leaking user existence.
   */
  async actionRequestReset() {
    // `loopar.auth.user()` returns the User row's `name`; the email comes from the row.
    const name = loopar.auth?.user?.();
    if (!name) {
      return this.error('You must be logged in to reset your password.');
    }

    const user = await loopar.db.getDoc('User', { name });
    if (!user?.email) {
      return this.success('If your account has an email on file, a reset link is on its way.');
    }

    const { rawToken } = await generatePasswordResetToken(user.email);
    if (rawToken) {
      try {
        await sendPasswordResetEmail(user, rawToken);
      } catch (err) {
        console.error('[auth/requestReset] failed to send email:', err.message);
        return this.error('Could not send the reset email. Please try again in a few minutes.');
      }
    }

    return this.success(`We sent a reset link to ${user.email}.`);
  }

  /**
   * GET /auth/oauth?provider=<google|github> — starts the Authorization Code
   * flow: CSRF `state` (+ PKCE for OIDC) stashed in a signed cookie, then
   * 302 to the provider.
   */
  async publicActionOauth() {
    const providerKey = String(this.query?.provider || '').trim().toLowerCase();
    // `popup=1` marks a window.open flow: the callback then answers with the
    // popup-close page (postMessage + close) instead of navigating.
    const popup = this.query?.popup === '1' || this.query?.popup === 1;
    const provider = getProvider(providerKey);
    if (!provider) return this.redirect('/auth/login?oauth=unknown_provider');

    const cfg = await loadProviderConfig(providerKey);
    if (!cfg) return this.redirect('/auth/login?oauth=not_configured');

    const redirectURI = oauthRedirectUri(this.req);
    const client = provider.client(cfg, redirectURI);
    const state = generateState();
    const scopes = parseScopes(cfg.scopes) || provider.defaultScopes;

    let codeVerifier = null;
    let url;
    if (provider.usesPKCE) {
      codeVerifier = generateCodeVerifier();
      url = provider.authUrl(client, { state, codeVerifier, scopes });
    } else {
      url = provider.authUrl(client, { state, scopes });
    }

    setOauthTx({ provider: providerKey, state, codeVerifier, popup });
    return this.redirect(url.toString(), { hard: true });
  }

  /**
   * Terminal response for the OAuth callback, aware of how the flow started.
   *
   * Popup flow → a tiny self-contained page that postMessages the result to
   * `window.opener` (origin-strict: targetOrigin is the page's own origin,
   * never '*') and closes itself. Full-page flow → the usual redirects.
   * When the tx cookie is missing/expired we can't know the flow — fall back
   * to redirect (worst case the login page renders inside the popup).
   */
  #oauthFinish(tx, { ok, landing = null, reason = null }) {
    if (!tx?.popup) {
      // Second factor pending: the login page resumes at the code step.
      if (reason === 'mfa_required') return this.redirect('/auth/login?mfa=1');
      return ok
        ? this.redirect(landing, { hard: true })
        : this.redirect(`/auth/login?oauth=${encodeURIComponent(reason || 'login_failed')}`);
    }

    const payload = JSON.stringify({
      type: 'loopar:oauth',
      ok: !!ok,
      landing: ok ? landing : null,
      reason: ok ? null : (reason || 'login_failed'),
    }).replace(/</g, '\\u003c');

    // Fallback when the window can't close itself (opener gone / opened as a
    // tab): the session cookie is already set on success, so landing works.
    const fallbackUrl = ok
      ? (landing || '/')
      : `/auth/login?oauth=${encodeURIComponent(reason || 'login_failed')}`;

    return this.html(`<!doctype html>
<html><head><meta charset="utf-8"><title>Signing in…</title></head>
<body style="font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<p style="opacity:.6">Completing sign in…</p>
<script>
(function () {
  var payload = ${payload};
  try {
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage(payload, window.location.origin);
    }
  } catch (e) {}
  window.close();
  setTimeout(function () {
    window.location.replace(${JSON.stringify(fallbackUrl)});
  }, 400);
})();
</script>
</body></html>`);
  }

  /**
   * GET /auth/oauthCallback?code&state — validates `state` against the tx
   * cookie, exchanges the code, links the verified email to a local User
   * (creates one only with allow_signup) and opens the session.
   */
  async publicActionOauthCallback() {
    const code = this.query?.code;
    const state = this.query?.state;
    const providerError = this.query?.error;

    // Read the tx FIRST: even error responses need to know whether the flow
    // runs in a popup (close-page) or a full page (redirect).
    const tx = readOauthTx();
    clearOauthTx();

    if (providerError) {
      return this.#oauthFinish(tx, { ok: false, reason: providerError });
    }

    if (!tx || !code || !state || state !== tx.state) {
      return this.#oauthFinish(tx, { ok: false, reason: 'invalid_state' });
    }

    const provider = getProvider(tx.provider);
    const cfg = await loadProviderConfig(tx.provider);
    if (!provider || !cfg) return this.#oauthFinish(tx, { ok: false, reason: 'not_configured' });

    const client = provider.client(cfg, oauthRedirectUri(this.req));

    let tokens;
    try {
      tokens = await provider.exchange(client, { code, codeVerifier: tx.codeVerifier });
    } catch (err) {
      console.error('[auth/oauth] code exchange failed:', err?.message);
      return this.#oauthFinish(tx, { ok: false, reason: 'exchange_failed' });
    }

    let profile;
    try {
      profile = await provider.profile(tokens);
    } catch (err) {
      console.error('[auth/oauth] profile fetch failed:', err?.message);
      return this.#oauthFinish(tx, { ok: false, reason: 'profile_failed' });
    }

    /* console.log('[auth/oauth] profile resolved:', {
      provider: tx.provider,
      email: profile?.email,
      email_verified: profile?.email_verified,
      sub: profile?.sub,
    }); */

    if (!profile?.email || !profile.email_verified) {
      return this.#oauthFinish(tx, { ok: false, reason: 'email_unverified' });
    }

    let user, reason;
    try {
      ({ user, reason } = await linkUser(profile, cfg, tx.provider));
    } catch (err) {
      console.error('[auth/oauth] linking failed:', err?.message);
      return this.#oauthFinish(tx, { ok: false, reason: 'link_error' });
    }
    console.log('[auth/oauth] link result:', { matchedUser: user?.name || null, reason: reason || null });
    if (!user) {
      return this.#oauthFinish(tx, { ok: false, reason: reason || 'login_failed' });
    }

    // System users → desk; Web users (self-signup) → website.
    const landing = user.user_type === 'Web' ? (process.env.WEB_LANDING || '/') : '/desk';
    const result = await completeLogin(user, { landing });
    if (result.mfa_locked) return this.#oauthFinish(tx, { ok: false, reason: 'mfa_locked' });
    if (result.mfa_required) return this.#oauthFinish(tx, { ok: false, reason: 'mfa_required' });
    return this.#oauthFinish(tx, { ok: true, landing });
  }

  /**
   * POST /auth/oauthProviders (public) — enabled providers for the login-form
   * buttons; never exposes secrets.
   */
  async publicActionOauthProviders() {
    const providers = [];
    for (const key of providerKeys()) {
      try {
        const cfg = await loadProviderConfig(key);
        if (cfg) providers.push({ provider: key, label: providerLabel(key) });
      } catch (err) {
        console.error(`[auth/oauthProviders] ${key} check failed:`, err?.message);
      }
    }
    return this.success('ok', { providers, notify: false });
  }

  /**
   * POST /auth/me (public) — session display info for the website top-nav.
   * The login JWT is httpOnly, so this is the client's read-only bridge.
   */
  async publicActionMe() {
    let session = null;
    try {
      session = await loopar.auth.award();
    } catch (_e) {
      session = null;
    }

    if (!session?.name) {
      return this.success('ok', { logged: false, notify: false });
    }

    return this.success('ok', {
      logged: true,
      name: session.name,
      email: session.email,
      avatar: session.avatar,
      profile_picture: session.profile_picture || null,
      user_type: session.user_type || null,
      notify: false,
    });
  }

  async #makeAction(form, fn) {
    this.client = "form";
    this.entry = "auth"; // bare auth form (no desk chrome)
    form = await loopar.newDocument(form, this.data);
    if (this.hasData()) {
      return await fn(form);
    } else {
      return await this.render(await form.__meta__());
    }
  }
}