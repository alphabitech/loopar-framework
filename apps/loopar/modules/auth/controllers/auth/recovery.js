import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import {loopar} from "loopar"

/**
 * On a website domain (tenant `sites`) password recovery only serves Web
 * users — same rule as Auth.login. Desk accounts are treated as unknown
 * there: no email is sent and links don't validate, with the same responses
 * as a non-existent account.
 */
function blockedOnSite(user) {
  return !!loopar.requestSite && user?.user_type !== 'Web';
}

function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * The account an email belongs to, or null (also null for desk accounts on a
 * website domain). Explicit query: `db.getDoc('User', { email })` ignores a
 * non-name filter and returns the first row.
 */
export async function findAccountByEmail(email) {
  if (!email) return null;
  const user = await loopar.db.query('User').where({ email })
    .select('name', 'email', 'user_type', 'disabled').first();
  return user && !blockedOnSite(user) ? user : null;
}

export async function generatePasswordResetToken(email) {
  const user = await findAccountByEmail(email);

  if (!user) return { ok: true };

  const rawToken = jwt.sign(
    { sub: user.name, purpose: 'password-reset' },
    loopar.jwtSecret,
    { expiresIn: '30m' }
  );

  await loopar.db.updateRow('User', user.name, {
    reset_password_token: hashToken(rawToken),
  });

  return { ok: true, user, rawToken };
}

export async function validatePasswordResetToken(rawToken) {
  let payload;
  try {
    payload = jwt.verify(rawToken, loopar.jwtSecret);
  } catch (e) {
    const reason = e.name === 'TokenExpiredError' ? 'expired' : 'invalid';
    return { valid: false, reason };
  }

  if (payload.purpose !== 'password-reset') {
    return { valid: false, reason: 'invalid' };
  }

  const user = await loopar.db.getDoc('User', { name: payload.sub });

  if (!user || blockedOnSite(user) || user.reset_password_token !== hashToken(rawToken)) {
    return { valid: false, reason: 'invalid' };
  }

  return { valid: true, user };
}

export async function resetPassword(rawToken, newPassword) {
  const { valid, reason, user } = await validatePasswordResetToken(rawToken);
  if (!valid) throw new Error(reason === 'expired' ? 'Link expired' : 'Invalid Link');

  const hashedPassword = await loopar.hash(newPassword);

  // Clear must_change_password — the user has chosen a password of their own,
  // so the auto-generated-credential banner should stop showing. Safe to set
  // unconditionally; users who never had the flag set are unaffected.
  await loopar.db.updateRow('User', user.name, {
    password: hashedPassword,
    reset_password_token: null,
    must_change_password: 0,
  });

  return { ok: true };
}