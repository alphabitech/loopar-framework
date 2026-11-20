'use strict';

/*
 * Sign-in links: a signed URL that opens a session for a portal (Web) user
 * without a password — the "View online" button of an emailed invoice, a
 * portal invitation, a cloud account activation.
 *
 *   const url = await signInLink(user, { landing: '/portal/Invoice/print?name=INV-…' });
 *   GET /auth/link?token=… → session + redirect to `landing`
 *
 * Two kinds:
 *   - reusable (default): valid until it expires. Revoked when the user
 *     changes password or is disabled (the token carries a fingerprint of the
 *     password hash). Mail scanners that open links can't burn it.
 *   - `once`: one use; it takes the user's reset slot, so the newest link (or
 *     password-reset email) is the only one that works.
 *
 * Desk (System) users never get one: their access always asks for the password.
 */

import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { loopar, getRequest } from 'loopar';
import { completeLogin } from './mfa.js';

const PURPOSE = 'sign-in-link';
export const SIGN_IN_PATH = '/auth/link';
const DEFAULT_LANDING = '/portal';

const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const truthy = (v) => [1, '1', true, 'true'].includes(v);
const fingerprint = (user) => sha256(`${user.name}|${user.password || ''}`).slice(0, 20);

/** Same-origin absolute path that is not an auth/api url, else the portal. */
export function safeLanding(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.includes('\\')) return DEFAULT_LANDING;
  if (/^\/(auth|api|loopar)(\/|\?|$)/i.test(path)) return DEFAULT_LANDING;
  return path;
}

/** Public origin of the current request (proxy headers first). */
export function requestOrigin() {
  const req = getRequest();
  const proto = String(req?.headers?.['x-forwarded-proto'] || req?.protocol || 'http').split(',')[0].trim();
  const host = String(req?.headers?.['x-forwarded-host'] || req?.headers?.host || process.env.DOMAIN || 'localhost').split(',')[0].trim();
  return `${proto}://${host}`;
}

const loadUser = (name) => loopar.db.getRow('User', name, ['name', 'email', 'user_type', 'disabled', 'password', 'reset_password_token']);

/**
 * Signed sign-in URL for Web user `userName`.
 *   landing: path to open once signed in (default: the portal home)
 *   ttl:     jsonwebtoken expiresIn (default 7 days)
 *   once:    single use (see above)
 *   origin:  absolute base of the URL (default: the current request's)
 */
export async function signInLink(userName, { landing = DEFAULT_LANDING, ttl = '7d', once = false, origin = null } = {}) {
  const user = await loadUser(userName);
  if (!user) loopar.throw({ code: 404, message: `User ${userName} does not exist.` });
  if (user.user_type !== 'Web') loopar.throw('Sign-in links are only for portal (Web) users.');
  if (truthy(user.disabled)) loopar.throw(`User ${userName} is disabled.`);

  const payload = { sub: user.name, purpose: PURPOSE, to: safeLanding(landing), fp: fingerprint(user) };
  if (once) payload.jti = crypto.randomUUID();
  const raw = jwt.sign(payload, loopar.jwtSecret, { expiresIn: ttl });
  if (once) await loopar.db.updateRow('User', user.name, { reset_password_token: sha256(raw) });

  return `${origin || requestOrigin()}${SIGN_IN_PATH}?token=${encodeURIComponent(raw)}`;
}

/** Where a link wants to go, even when it is no longer valid (for the login fallback). */
export function linkLanding(raw) {
  const payload = jwt.decode(String(raw || ''));
  return safeLanding(payload?.purpose === PURPOSE ? payload.to : null);
}

/**
 * Validates a link and, for a one-use link, consumes it.
 * Returns { user, landing } or null (invalid, expired, used or revoked).
 */
export async function consumeSignInLink(raw) {
  let payload;
  try {
    payload = jwt.verify(String(raw || ''), loopar.jwtSecret);
  } catch {
    return null;
  }
  if (payload?.purpose !== PURPOSE || !payload.sub) return null;

  const user = await loadUser(payload.sub);
  if (!user || user.user_type !== 'Web' || truthy(user.disabled)) return null;
  if (payload.fp !== fingerprint(user)) return null;

  if (payload.jti) {
    if (user.reset_password_token !== sha256(raw)) return null;
    await loopar.db.updateRow('User', user.name, { reset_password_token: null });
  }

  return { user, landing: safeLanding(payload.to) };
}

/**
 * Opens the session of a link and returns the page to go to: the landing,
 * the second-factor step, or the login page (with the landing as return
 * URL) when the link can't be used.
 */
export async function signInWithLink(raw) {
  const fallback = (reason) => `/auth/login?link=${reason}&redirect=${encodeURIComponent(linkLanding(raw))}`;
  const found = await consumeSignInLink(raw);
  if (!found) return fallback('invalid');

  // Already in as that user: just go there.
  if (loopar.auth.user() === found.user.name) return found.landing;

  const result = await completeLogin(found.user, { landing: found.landing });
  if (result.mfa_required) return '/auth/login?mfa=1';
  if (result.mfa_locked || !result.session) return fallback('locked');
  return found.landing;
}
