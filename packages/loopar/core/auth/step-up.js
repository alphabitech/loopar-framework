/**
 * Step-up (re-authentication) state. Changing a `protected` field (email,
 * password…) needs a fresh proof of identity on top of the session: the user
 * types their password (and a 2FA code when enabled) — see the app's
 * `Auth/reauthenticate` — which calls markStepUp(). The proof lives in the
 * server-side session, bound to the user, and expires after STEP_UP_TTL_MS.
 *
 * Fails closed: no session → no step-up.
 */
import { loopar } from '../loopar.js';

/** HTTP code the client reads as "ask for the password, then retry". */
export const STEP_UP_REQUIRED_CODE = 428;
export const STEP_UP_TTL_MS = 5 * 60 * 1000;

const KEY = '__step_up__';
const FAIL_KEY = '__step_up_fails__';
const MAX_FAILS = 5;
const FAIL_WINDOW_MS = 15 * 60 * 1000;

// Failures are ALSO counted per tenant+user in process memory: the session
// counter alone resets when a client drops its session cookie while keeping
// the (JWT) login cookie. One core process serves the tenants (pm2 instances: 1).
const failsByUser = new Map();
const userKey = (user) => `${loopar.tenantId || ''}:${user || ''}`;
const freshFails = (f) => !!f && Date.now() - f.since <= FAIL_WINDOW_MS;

export function markStepUp(user) {
  if (!user) return;
  loopar.session.set(KEY, { user, at: Date.now() });
  loopar.session.remove(FAIL_KEY);
  failsByUser.delete(userKey(user));
}

export function hasFreshStepUp(user, maxAgeMs = STEP_UP_TTL_MS) {
  const s = loopar.session.get(KEY);
  return !!(user && s && s.user === user && Number.isFinite(s.at) && Date.now() - s.at <= maxAgeMs);
}

export function clearStepUp() {
  loopar.session.remove(KEY);
}

export function requireStepUp(user) {
  if (!hasFreshStepUp(user)) {
    loopar.throw({
      code: STEP_UP_REQUIRED_CODE,
      title: 'Confirm your identity',
      message: 'Enter your password to change this field.',
    });
  }
}

/** Failed re-authentication attempts, per session AND per user (on top of the IP rate limit). */
export function stepUpLocked(user = loopar.auth?.user?.()) {
  const bySession = loopar.session.get(FAIL_KEY);
  const byUser = failsByUser.get(userKey(user));
  return (freshFails(bySession) && bySession.count >= MAX_FAILS)
    || (freshFails(byUser) && byUser.count >= MAX_FAILS);
}

export function registerStepUpFailure(user = loopar.auth?.user?.()) {
  const bump = (f) => (freshFails(f) ? { ...f, count: f.count + 1 } : { count: 1, since: Date.now() });
  loopar.session.set(FAIL_KEY, bump(loopar.session.get(FAIL_KEY)));
  if (user) failsByUser.set(userKey(user), bump(failsByUser.get(userKey(user))));
}
