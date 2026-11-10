'use strict';

/**
 * OAuth plumbing for the Auth controller: the short-lived transaction cookie
 * (carries provider + state + PKCE verifier between /auth/oauth and the
 * callback), provider-config loading, redirect-URI derivation, and the
 * verified-email -> User linking.
 *
 * Self-contained: depends only on `loopar` core + the provider registry.
 * No knowledge of any consumer module.
 */

import crypto from 'crypto';
import { loopar } from 'loopar';
import { getProvider } from './oauth-providers.js';

const TX_COOKIE = 'loopar_oauth_tx';
const TX_TTL_MS = 10 * 60 * 1000; // 10 minutes — covers the provider round-trip.

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const fromB64url = (s) => Buffer.from(String(s), 'base64url');

function sign(payloadB64) {
  return crypto.createHmac('sha256', String(loopar.jwtSecret)).update(payloadB64).digest('base64url');
}

/* ----------------------------- transaction cookie ----------------------------- */

export function setOauthTx({ provider, state, codeVerifier = null, popup = false, stepUpUser = null, remember = false }) {
  // `popup` records HOW the flow was started (window.open vs full-page
  // navigation) so the callback can answer with the popup-close page or a
  // normal redirect. It rides the signed cookie because the provider
  // round-trip gives us nowhere else to keep it.
  // `stepUpUser`: the flow re-authenticates this logged user (protected field
  // change) instead of opening a session.
  const payload = b64url(JSON.stringify({ provider, state, codeVerifier, popup: !!popup, stepUpUser: stepUpUser || null, remember: !!remember, ts: Date.now() }));
  loopar.cookie.set(TX_COOKIE, `${payload}.${sign(payload)}`, { maxAge: TX_TTL_MS, path: '/' });
}

export function readOauthTx() {
  const raw = loopar.cookie.get(TX_COOKIE);
  if (!raw || typeof raw !== 'string' || !raw.includes('.')) return null;

  const [payload, mac] = raw.split('.');
  const expected = sign(payload);
  try {
    if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  } catch {
    return null;
  }

  let tx;
  try {
    tx = JSON.parse(fromB64url(payload).toString('utf8'));
  } catch {
    return null;
  }

  if (!tx?.ts || Date.now() - tx.ts > TX_TTL_MS) return null;
  return tx;
}

export function clearOauthTx() {
  loopar.cookie.remove(TX_COOKIE, { path: '/' });
}

/* ------------------------------- config / uris -------------------------------- */

/**
 * The redirect URI registered with each provider. One per installation
 * (single domain → no wildcard problem). Derived from the incoming request,
 * overridable with OAUTH_BASE_URL for reverse-proxy edge cases.
 */
export function oauthRedirectUri(req) {
  const base =
    process.env.OAUTH_BASE_URL ||
    `${req?.secure ? 'https' : 'http'}://${req?.headers?.host || 'localhost'}`;
  return `${base.replace(/\/+$/, '')}/auth/oauthCallback`;
}

/** Build a provider config from operator env vars (the hosting/global default). */
function envProviderConfig(providerKey) {
  const P = providerKey.toUpperCase();
  const client_id = process.env[`OAUTH_${P}_CLIENT_ID`];
  const client_secret = process.env[`OAUTH_${P}_CLIENT_SECRET`];
  if (!client_id || !client_secret) return null;
  return {
    provider: providerKey,
    client_id,
    client_secret,
    scopes: process.env[`OAUTH_${P}_SCOPES`] || '',
    enabled: 1,
    allow_signup: process.env[`OAUTH_${P}_ALLOW_SIGNUP`] === '1' ? 1 : 0,
    _source: 'env',
  };
}

/**
 * Resolve a provider's config. Precedence: a per-install `Oauth Settings` row
 * (enabled + complete) overrides the operator's env default. The env fallback
 * is what lets a freshly provisioned tenant log in with the operator's shared
 * app without any per-tenant setup — only the keys are ever configured.
 */
/**
 * Filtered single-row lookup. `loopar.db.getDoc(entity, {field})` flattens the
 * object into its options bag and only honors a `name` key — every other field
 * (email, provider, sub) is silently DROPPED and the FIRST row is returned.
 * `getList` applies `filter` as a real WHERE, so we use it for any non-name match.
 */
async function findRow(document, filter) {
  const rows = await loopar.db.getList({ document, filter });
  return rows && rows.length ? rows[0] : null;
}

export async function loadProviderConfig(providerKey) {
  if (!getProvider(providerKey)) return null;
  const row = await findRow('Oauth Settings', { provider: providerKey });
  if (row && Number(row.enabled) === 1 && row.client_id && row.client_secret) {
    return row;
  }
  return envProviderConfig(providerKey);
}

export function parseScopes(scopes) {
  if (!scopes) return null;
  const arr = String(scopes).split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  return arr.length ? arr : null;
}

/* --------------------------------- linking ------------------------------------ */

/**
 * Resolve a verified OAuth profile to a local User. The identity anchor is the
 * stable (provider, sub) pair; the verified email is only the first-time bridge.
 * @returns {{ user: object|null, reason: string|null }}
 *   reason is set when login must be refused (not_member | disabled).
 */
export async function linkUser(profile, cfg, providerKey) {
  // 1) Canonical match by the provider's stable subject — survives email changes.
  if (profile.sub) {
    const bySub = await findRow('User', {
      oauth_provider: providerKey,
      oauth_sub: profile.sub,
    });
    if (bySub) {
      if (profile.picture && !bySub.profile_picture) {
        await loopar.db.updateRow('User', bySub.name, { profile_picture: profile.picture });
        bySub.profile_picture = profile.picture;
      }
      return guard(bySub);
    }
  }

  // 2) First-time bridge by verified email → anchor the sub onto that user.
  let user = await findRow('User', { email: profile.email });
  if (user) {
    const patch = {};
    if (profile.sub && (user.oauth_sub !== profile.sub || user.oauth_provider !== providerKey)) {
      patch.oauth_provider = providerKey;
      patch.oauth_sub = profile.sub;
    }
    // Adopt the provider photo only if the user has none of their own.
    if (profile.picture && !user.profile_picture) {
      patch.profile_picture = profile.picture;
    }
    if (Object.keys(patch).length) {
      await loopar.db.updateRow('User', user.name, patch);
      Object.assign(user, patch); // keep the row fresh for the login payload
    }
    return guard(user);
  }

  // 3) Unknown identity.
  if (Number(cfg.allow_signup) === 1) {
    const created = await createOauthUser(profile, providerKey);
    if (!created) return { user: null, reason: 'signup_failed' };
    return guard(created);
  }
  return { user: null, reason: 'not_member' };
}

function guard(user) {
  if (!user) return { user: null, reason: 'login_failed' };
  if (user.name !== 'Administrator' && Number(user.disabled) === 1) {
    return { user: null, reason: 'disabled' };
  }
  return { user, reason: null };
}

/**
 * Create a Web user from a verified profile (only reached when allow_signup is on).
 * Password is random and unused — the user authenticates through the provider.
 */
async function createOauthUser(profile, providerKey) {
  try {
    const randomPwd = crypto.randomBytes(24).toString('base64url');
    const doc = await loopar.newDocument('User');

    doc.name = profile.email;
    doc.email = profile.email;
    doc.first_name = profile.name || '';
    doc.password = randomPwd;
    doc.confirm_password = randomPwd;
    doc.user_type = 'Web';
    doc.oauth_provider = providerKey;
    doc.oauth_sub = profile.sub || '';
    doc.profile_picture = profile.picture || '';
    doc.__document_status__ = 'Active';

    await doc.save({ validate: false });
  } catch (err) {
    console.error('[auth/oauth] signup failed:', err?.message);
    return null;
  }

  // Re-read as a plain row so loopar.auth.login gets the same shape the
  // password-login and claim paths use.
  return await findRow('User', { email: profile.email });
}
