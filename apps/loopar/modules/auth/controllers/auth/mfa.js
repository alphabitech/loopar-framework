'use strict';

/**
 * Two-factor authentication (TOTP, RFC 6238) for the Auth module.
 *
 * Enrollment: a pending secret is kept (encrypted) until the user proves the
 * authenticator app works by entering its first code; only then it becomes
 * `mfa_secret` and 2FA turns on, returning one-time recovery codes.
 *
 * Login: `completeLogin()` is the single exit of every login path (password,
 * OAuth, claim). Without 2FA it opens the session as before. With 2FA it
 * does NOT: it stores a challenge on the User row and drops a short-lived
 * signed cookie; `verifyChallenge()` (POST /auth/mfaVerify) checks the code
 * and only then calls `loopar.auth.login()`.
 *
 * Brute force: 5 tries per challenge, and at most 10 failures per user in a
 * 15-minute window across challenges (a new password login does not reset
 * it). The IP rate limiter on the auth actions sits on top of this.
 *
 * Self-contained: depends only on `loopar` core + otpauth/qrcode.
 */

import crypto from 'crypto';
import { TOTP, Secret } from 'otpauth';
import QRCode from 'qrcode';
import { loopar } from 'loopar';

const PENDING_COOKIE = 'loopar_mfa_pending';
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_TRIES_PER_CHALLENGE = 5;
const LOCK_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS_PER_WINDOW = 10;
const RECOVERY_CODE_COUNT = 10;
const PERIOD = 30;

/** HTTP code for "the challenge is gone, sign in again" (client goes back to step 1). */
export const MFA_EXPIRED_CODE = 410;

const CLEARED = Object.freeze({
  mfa_enabled: 0,
  mfa_secret: '',
  mfa_pending_secret: '',
  mfa_recovery_codes: '',
  mfa_last_step: '',
  mfa_challenge: '',
});

/* ---------------------------------- helpers ---------------------------------- */

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const fromB64url = (s) => Buffer.from(String(s), 'base64url');
const currentStep = () => Math.floor(Date.now() / 1000 / PERIOD);

function sign(payloadB64) {
  return crypto.createHmac('sha256', String(loopar.jwtSecret)).update(`mfa.${payloadB64}`).digest('base64url');
}

function parseJSON(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function decrypt(value) {
  if (!value) return null;
  try {
    return loopar.isEncryptedSecret(value) ? loopar.decryptSecret(value) : null;
  } catch (err) {
    console.warn('[auth/mfa] could not decrypt secret:', err?.message);
    return null;
  }
}

/** `select('*')`: on a tenant whose schema predates 2FA the mfa_* keys are just absent. */
async function loadRow(name) {
  if (!name) return null;
  return await loopar.db.query('User').where({ name }).select('*').first();
}

const saveMfa = (name, data) => loopar.db.updateRow('User', name, data);

export const isMfaEnabled = (row) => !!row && loopar.utils.trueValue(row.mfa_enabled);

function buildTotp(secretB32, { issuer = 'Loopar', label = 'user' } = {}) {
  return new TOTP({
    issuer,
    label,
    algorithm: 'SHA1', // what every authenticator app supports
    digits: 6,
    period: PERIOD,
    secret: Secret.fromBase32(secretB32),
  });
}

/**
 * Step of a valid code (±1 step of clock drift) newer than `lastStep`, or
 * null. Refusing steps <= lastStep makes each code single-use.
 */
function matchTotp(secretB32, code, lastStep = 0) {
  const token = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(token)) return null;
  const delta = buildTotp(secretB32).validate({ token, window: 1 });
  if (delta === null) return null;
  const step = currentStep() + delta;
  return step > Number(lastStep || 0) ? step : null;
}

/* ------------------------------- recovery codes ------------------------------- */

const normalizeRecovery = (code) => String(code || '').toLowerCase().replace(/[^0-9a-f]/g, '');

function newRecoveryCode() {
  const raw = crypto.randomBytes(5).toString('hex'); // 10 hex chars = 40 bits
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

async function generateRecoveryCodes() {
  const plain = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
  const hashes = await Promise.all(plain.map((c) => loopar.hash(normalizeRecovery(c))));
  return { plain, hashes };
}

/** Remaining hashes after consuming `code`, or null when it matches none. */
async function consumeRecoveryCode(row, code) {
  const norm = normalizeRecovery(code);
  if (norm.length !== 10) return null;
  const hashes = parseJSON(row.mfa_recovery_codes, []);
  for (let i = 0; i < hashes.length; i++) {
    if (await loopar.verifyHash(norm, hashes[i])) return hashes.filter((_, j) => j !== i);
  }
  return null;
}

/**
 * Checks a second factor (TOTP code or recovery code) for an enabled user.
 * Returns the row updates that make it single-use, or null when invalid.
 */
async function checkFactor(row, { code, recovery_code }) {
  if (recovery_code) {
    const rest = await consumeRecoveryCode(row, recovery_code);
    return rest ? { mfa_recovery_codes: JSON.stringify(rest) } : null;
  }
  const secret = decrypt(row.mfa_secret);
  const step = secret ? matchTotp(secret, code, row.mfa_last_step) : null;
  return step ? { mfa_last_step: String(step) } : null;
}

/* ------------------------------- pending cookie ------------------------------- */

function setPendingCookie(data) {
  const payload = b64url(JSON.stringify({ ...data, ts: Date.now() }));
  loopar.cookie.set(PENDING_COOKIE, `${payload}.${sign(payload)}`, {
    maxAge: CHALLENGE_TTL_MS,
    path: '/',
    httpOnly: true,
  });
}

function readPendingCookie() {
  const raw = loopar.cookie.get(PENDING_COOKIE);
  if (!raw || typeof raw !== 'string' || !raw.includes('.')) return null;

  const [payload, mac] = raw.split('.');
  try {
    if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(sign(payload)))) return null;
  } catch {
    return null;
  }

  const data = parseJSON(fromB64url(payload).toString('utf8'), null);
  if (!data?.ts || Date.now() - data.ts > CHALLENGE_TTL_MS) return null;
  return data;
}

function clearPendingCookie() {
  loopar.cookie.remove(PENDING_COOKIE, { path: '/' });
}

/* ------------------------------------ login ----------------------------------- */

/**
 * Single exit of every login path. `landing` (url, or `(userRow) => url`)
 * is where a successful verification sends a full-page flow; it rides the
 * pending cookie.
 *
 * → { session }        2FA off: session opened (same as loopar.auth.login)
 * → { mfa_required }   2FA on: challenge issued, no session yet
 * → { mfa_locked }     too many recent failures for this user
 */
export async function completeLogin(user, { landing = null } = {}) {
  // The full row: callers hand in partial shapes (Auth.getUser has no
  // user_type), and the session must carry the real user type.
  const row = (await loadRow(user?.name)) || user;
  loopar.auth.assertLoginAllowed(row);

  if (!isMfaEnabled(row)) {
    return { session: loopar.auth.login(row) };
  }

  const now = Date.now();
  const prev = parseJSON(row.mfa_challenge, null);
  const inWindow = !!prev?.window_start && now - prev.window_start < LOCK_WINDOW_MS;
  const fails = inWindow ? Number(prev.fails || 0) : 0;

  loopar.auth.killSession();
  if (fails >= MAX_FAILS_PER_WINDOW) {
    clearPendingCookie();
    return { mfa_locked: true };
  }

  const challenge = {
    nonce: crypto.randomBytes(16).toString('base64url'),
    exp: now + CHALLENGE_TTL_MS,
    tries: 0,
    fails,
    window_start: inWindow ? prev.window_start : now,
  };
  await saveMfa(row.name, { mfa_challenge: JSON.stringify(challenge) });
  setPendingCookie({
    user: row.name,
    nonce: challenge.nonce,
    landing: typeof landing === 'function' ? landing(row) : landing,
  });

  return { mfa_required: true };
}

/** Is there a live challenge for this browser? (lets the login form resume step 2) */
export function hasPendingChallenge() {
  return !!readPendingCookie();
}

export function cancelChallenge() {
  clearPendingCookie();
}

/**
 * POST /auth/mfaVerify body: { code } or { recovery_code }.
 * Opens the session on success → { session, landing, used_recovery }.
 */
export async function verifyChallenge({ code, recovery_code } = {}) {
  const expired = (message = 'Your verification expired. Please sign in again.') => {
    clearPendingCookie();
    loopar.throw({ code: MFA_EXPIRED_CODE, title: 'Verification expired', message });
  };

  const pending = readPendingCookie();
  if (!pending?.user || !pending?.nonce) return expired();

  const row = await loadRow(pending.user);
  const challenge = parseJSON(row?.mfa_challenge, null);
  if (
    !isMfaEnabled(row) ||
    !challenge?.nonce ||
    challenge.nonce !== pending.nonce ||
    Date.now() > challenge.exp ||
    (row.disabled && row.name !== 'Administrator')
  ) {
    return expired();
  }

  const updates = await checkFactor(row, { code, recovery_code });

  if (!updates) {
    challenge.tries = Number(challenge.tries || 0) + 1;
    challenge.fails = Number(challenge.fails || 0) + 1;
    const exhausted = challenge.tries >= MAX_TRIES_PER_CHALLENGE || challenge.fails >= MAX_FAILS_PER_WINDOW;
    if (exhausted) challenge.nonce = null;
    await saveMfa(row.name, { mfa_challenge: JSON.stringify(challenge) });

    if (exhausted) return expired('Too many invalid codes. Please sign in again.');
    loopar.throw({
      code: 401,
      title: 'Verification failed',
      message: recovery_code ? 'Invalid recovery code.' : 'Invalid verification code.',
    });
  }

  await saveMfa(row.name, { ...updates, mfa_challenge: '' });
  clearPendingCookie();

  const session = loopar.auth.login(row, { mfa: true });
  return { session, landing: pending.landing || null, used_recovery: !!recovery_code };
}

/* --------------------------------- enrollment --------------------------------- */

async function requireRow(name) {
  const row = await loadRow(name);
  if (!row) loopar.throw({ code: 404, message: 'User not found.' });
  return row;
}

export async function mfaStatus(name) {
  const row = await requireRow(name);
  return {
    enabled: isMfaEnabled(row),
    recovery_codes_left: isMfaEnabled(row) ? parseJSON(row.mfa_recovery_codes, []).length : 0,
  };
}

/** Step 1: new pending secret → QR + manual key. Replaces any unfinished setup. */
export async function beginSetup(name, { issuer = 'Loopar' } = {}) {
  const row = await requireRow(name);
  if (isMfaEnabled(row)) loopar.throw('Two-factor authentication is already enabled.');

  const secret = new Secret({ size: 20 });
  await saveMfa(name, { mfa_pending_secret: loopar.encryptSecret(secret.base32) });

  const uri = buildTotp(secret.base32, { issuer, label: row.email || row.name }).toString();
  return {
    uri,
    secret: secret.base32,
    qr: await QRCode.toDataURL(uri, { margin: 1, width: 220 }),
  };
}

/** Step 2: first code proves the app works → 2FA on, recovery codes shown once. */
export async function confirmSetup(name, code) {
  const row = await requireRow(name);
  if (isMfaEnabled(row)) loopar.throw('Two-factor authentication is already enabled.');

  const pending = decrypt(row.mfa_pending_secret);
  if (!pending) loopar.throw('The setup expired. Please start again.');

  const step = matchTotp(pending, code, 0);
  if (!step) loopar.throw('Invalid code. Check that the time on your phone is correct and try again.');

  const { plain, hashes } = await generateRecoveryCodes();
  await saveMfa(name, {
    ...CLEARED,
    mfa_enabled: 1,
    mfa_secret: loopar.encryptSecret(pending),
    mfa_last_step: String(step),
    mfa_recovery_codes: JSON.stringify(hashes),
  });

  return { recovery_codes: plain };
}

async function requireFactor(row, factor) {
  if (!isMfaEnabled(row)) loopar.throw('Two-factor authentication is not enabled.');
  const updates = await checkFactor(row, factor || {});
  if (!updates) loopar.throw({ code: 401, message: 'Invalid verification code.' });
  return updates;
}

export async function disableMfa(name, factor) {
  const row = await requireRow(name);
  await requireFactor(row, factor);
  await saveMfa(name, { ...CLEARED });
}

export async function regenerateRecoveryCodes(name, factor) {
  const row = await requireRow(name);
  const updates = await requireFactor(row, factor);
  const { plain, hashes } = await generateRecoveryCodes();
  await saveMfa(name, { ...updates, mfa_recovery_codes: JSON.stringify(hashes) });
  return { recovery_codes: plain };
}

/** Admin / CLI: turn 2FA off without a code (lost phone and recovery codes). */
export async function resetMfa(name) {
  await requireRow(name);
  await saveMfa(name, { ...CLEARED });
}
