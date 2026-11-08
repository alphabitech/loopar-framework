/**
 * Verified email change.
 *
 * A user's email is the recovery channel (password reset links go there), so
 * changing it is account takeover if done on a stolen session. Flow:
 *
 *   1. requestEmailChange(): only after a fresh re-authentication (the caller
 *      checks it). Sends a confirmation link to the NEW address and a heads-up
 *      to the CURRENT one. Nothing changes yet.
 *   2. confirmEmailChange(token): the link proves the user owns the new
 *      address; the email changes and the previous address is notified.
 *
 * The token is stateless (HMAC with the tenant's jwtSecret, like the 2FA
 * pending cookie): it carries the user, the new email, an expiry and a
 * fingerprint of the current email + password hash — once the email (or the
 * password) changes the fingerprint no longer matches, so every link is
 * single-use and dies with a password reset.
 */
import crypto from 'crypto';
import { loopar, getRequest } from 'loopar';
import { sendEmailChangeConfirmation, sendEmailChangedNotice } from './recovery-email.js';

const TTL_MS = 24 * 60 * 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const b64url = (v) => Buffer.from(v).toString('base64url');
const sign = (payload) => crypto
  .createHmac('sha256', String(loopar.jwtSecret))
  .update(`email-change.${payload}`)
  .digest('base64url');

const fingerprint = (row) => crypto
  .createHash('sha256')
  .update(`${String(row?.email || '').toLowerCase()}|${row?.password || ''}`)
  .digest('base64url')
  .slice(0, 24);

/**
 * Origin for the link. The host is the one this request was ROUTED on (the
 * tenant registry resolved this tenant from it), never X-Forwarded-Host,
 * which a client could set.
 */
function origin() {
  const req = getRequest();
  const proto = String(req?.headers?.['x-forwarded-proto'] || req?.protocol || 'http').split(',')[0].trim();
  const host = String(req?.headers?.host || process.env.DOMAIN || 'localhost').split(',')[0].trim();
  return `${proto === 'https' ? 'https' : 'http'}://${host}`;
}

async function isTaken(email, userName) {
  return !!(await loopar.db.query('User').whereRaw('LOWER(email) = ?', [email]).whereNot({ name: userName }).first('name'));
}

async function loadUser(name) {
  return await loopar.db.query('User').where({ name }).select('name', 'email', 'password', 'first_name', 'last_name', 'disabled').first();
}

function normalizeEmail(value) {
  const email = String(value ?? '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) loopar.throw({ code: 400, message: 'Enter a valid email address.' });
  return email;
}

/** Admin / confirmation paths: a clear error (admins already see the user list). */
async function assertAvailable(email, userName) {
  if (await isTaken(email, userName)) loopar.throw({ code: 409, message: 'That email address is already in use.' });
}

/**
 * Step 1. → { message } for the client. The caller has already verified a
 * fresh re-authentication of `userName` (or an admin acting on it).
 */
export async function requestEmailChange(userName, newEmail) {
  const user = await loadUser(userName);
  if (!user) loopar.throw({ code: 404, message: 'User not found.' });

  const email = normalizeEmail(newEmail);
  if (email === String(user.email || '').toLowerCase()) {
    loopar.throw({ code: 400, message: 'That is already your email address.' });
  }

  // Same answer whether the address is free or not: a self-service user must
  // not be able to probe which emails have an account on this site.
  const neutral = { message: `If ${email} can be used, we sent it a confirmation link. Your email changes when you open it.` };
  if (await isTaken(email, user.name)) {
    console.info(`[auth/email-change] ${user.name}: requested an address already in use — nothing sent`);
    return neutral;
  }

  const payload = b64url(JSON.stringify({ u: user.name, e: email, f: fingerprint(user), exp: Date.now() + TTL_MS }));
  const token = `${payload}.${sign(payload)}`;
  const url = `${origin()}/auth/confirmEmailChange?token=${encodeURIComponent(token)}`;

  await sendEmailChangeConfirmation({ user, newEmail: email, url });
  if (user.email) {
    try {
      await sendEmailChangedNotice({ to: user.email, user, newEmail: email, pending: true });
    } catch (err) {
      console.warn('[auth/email-change] could not notify the current address:', err?.message);
    }
  }

  return neutral;
}

function readToken(token) {
  const raw = String(token || '');
  const dot = raw.lastIndexOf('.');
  if (dot < 1) return null;
  const payload = raw.slice(0, dot);
  const mac = raw.slice(dot + 1);
  try {
    if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(sign(payload)))) return null;
  } catch {
    return null;
  }
  let data;
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!data?.u || !data?.e || !data?.f || !Number.isFinite(data.exp) || Date.now() > data.exp) return null;
  return data;
}

/**
 * Step 2. → { ok: true, user } or { ok: false, reason } ('invalid' |
 * 'expired_or_used' | 'in_use'). Never throws for a bad link: the caller
 * shows a page.
 */
export async function confirmEmailChange(token) {
  const data = readToken(token);
  if (!data) return { ok: false, reason: 'invalid' };

  const user = await loadUser(data.u);
  if (!user || ([1, '1', true].includes(user.disabled) && user.name !== 'Administrator')) return { ok: false, reason: 'invalid' };
  if (fingerprint(user) !== data.f) return { ok: false, reason: 'expired_or_used' };

  try {
    await assertAvailable(data.e, user.name);
  } catch {
    return { ok: false, reason: 'in_use' };
  }

  const previous = user.email;
  const doc = await loopar.getDocument('User', user.name);
  doc.authorize('email');
  doc.email = data.e;
  doc.password = doc.protectedPassword;
  doc.confirm_password = doc.protectedPassword;
  await doc.save();

  if (previous) {
    try {
      await sendEmailChangedNotice({ to: previous, user, newEmail: data.e, pending: false });
    } catch (err) {
      console.warn('[auth/email-change] could not notify the previous address:', err?.message);
    }
  }
  console.info(`[auth/email-change] ${user.name}: email changed`);
  return { ok: true, user: user.name };
}

/**
 * Direct change by someone else with authority over the record (an admin with
 * `update` on User, after re-authenticating THEMSELVES). The owner is told at
 * the previous address.
 */
export async function adminSetEmail(userName, newEmail) {
  const email = normalizeEmail(newEmail);
  await assertAvailable(email, userName);

  const doc = await loopar.getDocument('User', userName);
  const previous = doc.email;
  doc.authorize('email');
  doc.email = email;
  doc.password = doc.protectedPassword;
  doc.confirm_password = doc.protectedPassword;
  await doc.save();

  if (previous && previous.toLowerCase() !== email) {
    try {
      await sendEmailChangedNotice({ to: previous, user: { name: userName }, newEmail: email, pending: false });
    } catch (err) {
      console.warn('[auth/email-change] could not notify the previous address:', err?.message);
    }
  }
  return { message: `Email updated to ${email}.` };
}
