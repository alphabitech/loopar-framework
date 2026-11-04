'use strict';

/**
 * Debug tokens — bearer credentials for agents and scripts that read the
 * Debugger over /api/Debugger/* without a browser session.
 *
 *   Authorization: Bearer ldbg_<id>_<secret>
 *
 * Only a SHA-256 of the token is stored (the secret is 256 random bits, so a
 * fast hash is enough); the plaintext is returned once, at creation. A token
 * authenticates ONLY on the Debugger's API actions (DebuggerController), so
 * it can never act as a user anywhere else in the desk.
 *
 * Scopes: `read` (requests, SQL, logs, errors, status, test results) and
 * `run` (also starts and cancels test runs).
 */

import crypto from 'node:crypto';
import { loopar } from 'loopar';

export const TOKEN_ENTITY = 'Debug Token';
/** Set by createToken on the document it mints; DebugToken.save() requires it for new tokens. */
export const MINTING = Symbol('debugToken.minting');
export const TOKEN_SCOPES = ['read', 'run'];
const TOKEN_RE = /^ldbg_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;
const TOUCH_EVERY_MS = 60 * 1000;
const FIELDS = ['name', 'label', 'scope', 'token_hint', 'expires_at', 'last_used_at', 'last_used_ip', 'disabled'];

const sha256 = (text) => crypto.createHash('sha256').update(String(text)).digest('hex');

/**
 * The bearer token of a request, or null when it doesn't carry one. Other
 * schemes (HTTP Basic from a proxy in front of the site) are not ours: the
 * request goes through the session path as usual. A malformed Bearer value
 * comes back as '' and is rejected.
 */
export function bearerFrom(req) {
  const header = String(req?.headers?.authorization ?? '').trim();
  if (!/^Bearer(\s|$)/i.test(header)) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(header);
  return m ? m[1] : '';
}

export async function createToken({ label, scope = 'read', days = 30 } = {}) {
  const name = String(label ?? '').trim();
  if (!name || name.length > 80) loopar.throw({ code: 400, message: 'A label (1–80 characters) is required.' });
  if (!TOKEN_SCOPES.includes(scope)) loopar.throw({ code: 400, message: `Scope must be one of: ${TOKEN_SCOPES.join(', ')}.` });
  const lifetime = Number(days);
  if (!Number.isInteger(lifetime) || lifetime < 0 || lifetime > 365) {
    loopar.throw({ code: 400, message: 'Lifetime must be 0 (never expires) to 365 days.' });
  }

  const id = crypto.randomBytes(6).toString('hex');
  const token = `ldbg_${id}_${crypto.randomBytes(32).toString('base64url')}`;
  const expiresAt = lifetime ? new Date(Date.now() + lifetime * 24 * 60 * 60 * 1000).toISOString() : '';

  const doc = await loopar.newDocument(TOKEN_ENTITY, {
    name: id,
    label: name,
    scope,
    token_hash: sha256(token),
    token_hint: `ldbg_${id}_…`,
    expires_at: expiresAt,
    last_used_at: '',
    last_used_ip: '',
    disabled: 0,
  });
  doc[MINTING] = true;
  await doc.save();

  return { token, info: { name: id, label: name, scope, expires_at: expiresAt } };
}

export async function listTokens() {
  const rows = await loopar.db.getAll(TOKEN_ENTITY, FIELDS);
  return rows
    .map((r) => ({ ...r, disabled: !!Number(r.disabled), expired: !!(r.expires_at && Date.parse(r.expires_at) <= Date.now()) }))
    .sort((a, b) => String(b.last_used_at || '').localeCompare(String(a.last_used_at || '')));
}

export async function revokeToken(name) {
  if (!name) loopar.throw({ code: 400, message: 'Token name is required.' });
  const doc = await loopar.getDocument(TOKEN_ENTITY, String(name));
  // Hard delete: a revoked credential is not something to restore.
  await doc.delete({ sofDelete: false });
  return true;
}

/**
 * Resolve a bearer token. Throws 401 (always the same message) when it is
 * malformed, unknown, disabled or expired. Records last use (throttled).
 * @returns {Promise<{ name: string, label: string, scope: 'read'|'run' }>}
 */
export async function verifyToken(raw, { ip = null } = {}) {
  const reject = () => loopar.throw({ code: 401, title: 'Unauthorized', message: 'Invalid or expired debug token.' });

  const m = TOKEN_RE.exec(String(raw || ''));
  if (!m) return reject();

  let row = null;
  try {
    // getDoc skips soft-deleted rows (a token deleted from the desk list).
    row = await loopar.db.getDoc(TOKEN_ENTITY, m[1], ['name', 'label', 'scope', 'token_hash', 'expires_at', 'disabled', 'last_used_at']);
  } catch {
    row = null;
  }
  if (!row) return reject();

  const given = Buffer.from(sha256(raw), 'hex');
  const stored = Buffer.from(String(row.token_hash || ''), 'hex');
  if (given.length !== stored.length || !crypto.timingSafeEqual(given, stored)) return reject();
  if (Number(row.disabled)) return reject();
  if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) return reject();

  const last = Date.parse(row.last_used_at || '');
  if (!last || Date.now() - last > TOUCH_EVERY_MS) {
    try {
      await loopar.db.query(TOKEN_ENTITY).where({ name: row.name })
        .update({ last_used_at: new Date().toISOString(), last_used_ip: String(ip || '').slice(0, 64) });
    } catch { /* usage stamp is best effort */ }
  }

  return { name: row.name, label: row.label, scope: TOKEN_SCOPES.includes(row.scope) ? row.scope : 'read' };
}
