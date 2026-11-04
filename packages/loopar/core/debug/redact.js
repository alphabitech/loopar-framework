'use strict';

/**
 * Redaction for everything the debugger keeps: SQL bindings, request
 * params and headers. The debugger is for reading what the framework did,
 * never a way to read back credentials, so anything that looks like one is
 * replaced by REDACTED before it is stored.
 *
 * Column/key based: a value is masked when the column (SQL) or key (params)
 * it belongs to has a sensitive name, plus a few value shapes that are
 * always secrets (password hashes, JWTs, debug tokens) wherever they appear.
 */

export const REDACTED = '[redacted]';

const SENSITIVE_NAME = /pass(word)?|pwd|secret|token|api_?key|private_?key|hmac|salt|otp|totp|mfa|recovery_code|credential|jwt|signature|cookie|authorization|^hash$|_hash$/i;
const SECRET_VALUE = /^(\$argon2|\$2[aby]\$|eyJ[\w-]{8,}\.[\w-]{8,}\.|ldbg_|sk_(live|test)_|ghp_|github_pat_)/;

const MAX_STRING = 200;
const MAX_KEYS = 50;
const MAX_DEPTH = 3;
const MAX_ITEMS = 20;

// Request params (query string, body) also carry one-time codes and OAuth
// state; as SQL column names these are ordinary data and stay visible.
const SENSITIVE_PARAM = /^(code|state|otp_code|verification_code|nonce)$/i;
const MAX_BINDINGS = 100;

export const isSensitiveName = (name) => SENSITIVE_NAME.test(String(name ?? ''));
export const isSensitiveParam = (name) => isSensitiveName(name) || SENSITIVE_PARAM.test(String(name ?? ''));

// Secrets embedded in free text (log lines, error messages, URLs).
const TEXT_SECRETS = [
  // ?token=…&code=… in URLs and query strings
  [/([?&;](?:[\w.-]*(?:token|secret|password|passwd|pwd|api_?key|signature|hmac|code|state|otp|jwt)[\w.-]*)=)[^&\s"'#<>]+/gi, '$1[redacted]'],
  // JWTs, debug tokens, password hashes, common provider keys
  [/eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]*/g, REDACTED],
  [/ldbg_[0-9a-f]{12}_[\w-]{43}/g, REDACTED],
  [/\$argon2[a-z]*\$[^\s'"]+/g, REDACTED],
  [/\$2[aby]\$\d{2}\$[./\w]{53}/g, REDACTED],
  [/\b(?:sk|rk)_(?:live|test)_[\w]{8,}/g, REDACTED],
  [/\b(?:ghp|gho|ghu|ghs)_[\w]{20,}|\bgithub_pat_[\w]{20,}/g, REDACTED],
];

/** Mask secret-looking substrings in free text. */
export function scrubText(text) {
  let out = String(text ?? '');
  for (const [re, rep] of TEXT_SECRETS) out = out.replace(re, rep);
  return out;
}

/** A request URL with its sensitive query params masked (path kept as is). */
export function redactUrl(url) {
  const raw = String(url ?? '');
  const q = raw.indexOf('?');
  if (q < 0) return raw;
  const path = raw.slice(0, q);
  const hashAt = raw.indexOf('#', q);
  const query = raw.slice(q + 1, hashAt < 0 ? undefined : hashAt);
  const parts = query.split('&').map((pair) => {
    const eq = pair.indexOf('=');
    if (eq < 0) return pair;
    let key = pair.slice(0, eq);
    try { key = decodeURIComponent(key.replace(/\+/g, ' ')); } catch { /* keep raw */ }
    return isSensitiveParam(key) && pair.length > eq + 1 ? `${pair.slice(0, eq)}=${REDACTED}` : pair;
  });
  return scrubText(`${path}?${parts.join('&')}`);
}

/** Clip a string to `max` chars, saying how much was dropped. */
export function clip(value, max = MAX_STRING) {
  const s = String(value ?? '');
  return s.length > max ? `${s.slice(0, max)}…(+${s.length - max} chars)` : s;
}

/** A storable, size-bounded copy of a scalar binding/param value. */
export function safeValue(value) {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') return SECRET_VALUE.test(value) ? REDACTED : clip(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) return `[binary ${value.length} bytes]`;
  if (ArrayBuffer.isView(value)) return `[binary ${value.byteLength} bytes]`;
  try { return clip(JSON.stringify(value)); } catch { return `[${typeof value}]`; }
}

/** Deep, bounded copy of a params object (query, body) with sensitive keys masked. */
export function redactObject(input, depth = 0) {
  if (input === null || input === undefined) return input ?? null;
  if (Array.isArray(input)) {
    const out = input.slice(0, MAX_ITEMS).map((v) => (v && typeof v === 'object' && depth < MAX_DEPTH ? redactObject(v, depth + 1) : safeValue(v)));
    if (input.length > MAX_ITEMS) out.push(`…(+${input.length - MAX_ITEMS} items)`);
    return out;
  }
  if (typeof input !== 'object' || input instanceof Date || (typeof Buffer !== 'undefined' && Buffer.isBuffer(input))) {
    return safeValue(input);
  }
  const out = {};
  const keys = Object.keys(input);
  for (const key of keys.slice(0, MAX_KEYS)) {
    if (key === '__REQ_FILES__') continue;
    const v = input[key];
    if (isSensitiveParam(key)) out[key] = v === '' || v == null ? v ?? null : REDACTED;
    else if (v && typeof v === 'object' && !(v instanceof Date)) out[key] = depth < MAX_DEPTH ? redactObject(v, depth + 1) : '[object]';
    else out[key] = safeValue(v);
  }
  if (keys.length > MAX_KEYS) out['…'] = `+${keys.length - MAX_KEYS} keys`;
  return out;
}

// Headers worth reading when debugging; credentials (cookie, authorization,
// csrf/workspace tokens) are simply never copied.
const KEPT_HEADERS = ['host', 'user-agent', 'referer', 'accept', 'accept-language', 'content-type', 'content-length', 'x-requested-with', 'origin'];

export function pickHeaders(headers = {}) {
  const out = {};
  for (const h of KEPT_HEADERS) if (headers[h] != null) out[h] = clip(headers[h], 300);
  return out;
}

/**
 * Placeholder positions of a SQL string: `?` (knex/mysql/sqlite) or `$n`
 * (postgres), skipping string literals and quoted identifiers.
 * Returns [{ pos, index }] — `index` is the binding it consumes.
 */
function placeholders(sql) {
  const out = [];
  let next = 0;
  let quote = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (quote) {
      if (ch === quote) {
        if (sql[i + 1] === quote) i++; // escaped quote
        else quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '[') { const end = sql.indexOf(']', i); if (end > i) { i = end; continue; } }
    if (ch === '?') {
      if (sql[i + 1] === '?') { i++; continue; } // knex identifier placeholder
      out.push({ pos: i, index: next++ });
      continue;
    }
    if (ch === '$' && /\d/.test(sql[i + 1] || '')) {
      let j = i + 1;
      while (/\d/.test(sql[j] || '')) j++;
      out.push({ pos: i, index: Number(sql.slice(i + 1, j)) - 1 });
      i = j - 1;
    }
  }
  return out;
}

const unquote = (id) => String(id).trim().replace(/^[`"[]|[`"\]]$/g, '').split('.').pop().replace(/^[`"[]|[`"\]]$/g, '');

// `col = ?`, `col <> ?`, `col like ?`, `col in (?, ?` … right before a placeholder.
const COLUMN_BEFORE = /([`"[]?[A-Za-z_][\w$]*[`"\]]?)\s*(?:=|<>|!=|<=|>=|<|>|\blike\b|\bilike\b|\bin\s*\([^()]*)\s*$/i;

/** Columns of `insert into t (a, b) values (?, ?)` — positional, multi-row. */
function insertColumns(sql) {
  const m = /^\s*insert\s+(?:or\s+\w+\s+)?into\s+[^(]+\(([^)]*)\)\s*values/i.exec(sql);
  return m ? m[1].split(',').map(unquote) : null;
}

/** Bindings safe to store: secrets masked, big values clipped. */
export function redactBindings(sql, bindings) {
  if (!Array.isArray(bindings) || bindings.length === 0) return [];
  const text = String(sql || '');
  const masked = new Set();

  const cols = insertColumns(text);
  const valuesAt = cols ? text.search(/\bvalues\b/i) : -1;

  let valueOrdinal = 0;
  for (const { pos, index } of placeholders(text)) {
    if (index >= MAX_BINDINGS) break;
    let column = null;
    if (cols && pos > valuesAt) {
      column = cols[valueOrdinal++ % cols.length];
    } else {
      const m = COLUMN_BEFORE.exec(text.slice(Math.max(0, pos - 240), pos));
      column = m ? unquote(m[1]) : null;
    }
    if (column && isSensitiveName(column)) masked.add(index);
  }

  const kept = bindings.slice(0, MAX_BINDINGS)
    .map((v, i) => (masked.has(i) && v !== null && v !== undefined && v !== '' ? REDACTED : safeValue(v)));
  if (bindings.length > MAX_BINDINGS) kept.push(`…(+${bindings.length - MAX_BINDINGS} bindings)`);
  return kept;
}
