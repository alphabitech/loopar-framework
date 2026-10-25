import { loopar } from '../loopar.js';

/**
 * Naming series: sequential, human-readable document names (CLI-0001).
 *
 * An entity opts in with `naming_series`, a pattern of dot-separated parts:
 *
 *   CLI-.####          → CLI-0001, CLI-0002 …
 *   INV-.YYYY.-.#####  → INV-2026-00001 (the counter restarts every year)
 *
 * Parts: `#…` is the counter (its length is the zero padding, exactly one
 * per pattern); YYYY, YY, MM and DD are the current date; anything else is
 * literal text. Everything before the counter is the series key: each
 * distinct key keeps its own counter in the `Naming Series` entity, so date
 * parts give periodic resets for free.
 */

const COUNTER_ENTITY = "Naming Series";
const DATE_PARTS = {
  YYYY: d => String(d.getFullYear()),
  YY: d => String(d.getFullYear()).slice(-2),
  MM: d => String(d.getMonth() + 1).padStart(2, "0"),
  DD: d => String(d.getDate()).padStart(2, "0"),
};

/** Returns an error message for an invalid pattern, or null when valid. */
export function namingSeriesError(pattern) {
  if (!pattern) return null;
  const parts = String(pattern).split(".");
  if (parts.some(p => p.includes("#") && !/^#+$/.test(p))) {
    return `Naming series "${pattern}": the counter must be its own part, separated by dots (e.g. CLI-.####).`;
  }
  if (parts.filter(p => /^#+$/.test(p)).length !== 1) {
    return `Naming series "${pattern}" must contain exactly one counter part (e.g. CLI-.####).`;
  }
  if (parts.some(p => /[^A-Za-z0-9_\- #\/]/.test(p))) {
    return `Naming series "${pattern}" may only contain letters, numbers, spaces, "-", "_" and "/".`;
  }
  return null;
}

function resolve(pattern, date = new Date()) {
  let prefix = "", suffix = "", width = 0;
  for (const part of String(pattern).split(".")) {
    if (/^#+$/.test(part)) { width = part.length; continue; }
    const text = DATE_PARTS[part] ? DATE_PARTS[part](date) : part;
    width ? (suffix += text) : (prefix += text);
  }
  return { prefix, suffix, width };
}

// Serializes counter updates per tenant + series key. This is enough while
// the core runs as a single process (see the deploy notes: instances:1);
// a clustered deploy needs a DB-level lock here instead.
const queues = new Map();
function serialized(key, fn) {
  const prev = queues.get(key) || Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  queues.set(key, tail);
  tail.then(() => queues.get(key) === tail && queues.delete(key));
  return run;
}

// `!` as LIKE escape: a backslash literal is parsed differently by MySQL.
const escapeLike = s => s.replace(/[!%_]/g, c => `!${c}`);

/**
 * Highest counter already used in `entity` for this prefix/suffix. Seeds a
 * series added to an entity that already has records, and protects against
 * names entered by hand. Includes soft-deleted rows: their names are still
 * taken (inserting one would restore the deleted row).
 */
async function highestUsed(entity, { prefix, suffix }) {
  const rows = await loopar.db.query(entity)
    .whereRaw("name LIKE ? ESCAPE '!'", [`${escapeLike(prefix)}%${escapeLike(suffix)}`])
    .select("name");

  let max = 0;
  for (const { name } of rows) {
    const middle = String(name).slice(prefix.length, String(name).length - suffix.length);
    if (/^\d+$/.test(middle)) max = Math.max(max, parseInt(middle, 10));
  }
  return max;
}

/** Reserves and returns the next name for `entity` using `pattern`. */
export async function nextSeriesName(entity, pattern) {
  const error = namingSeriesError(pattern);
  if (error) loopar.throw(error);

  const parts = resolve(pattern);
  const key = parts.prefix + "#" + parts.suffix;

  return serialized(`${loopar.tenantId}|${key}`, async () => {
    const stored = await loopar.db.getValue(COUNTER_ENTITY, "current", key, { ifNotFound: null });
    const used = await highestUsed(entity, parts);
    const next = Math.max(parseInt(stored) || 0, used) + 1;

    if (stored == null) {
      await loopar.db.insertRow(COUNTER_ENTITY, { name: key, current: next });
    } else {
      await loopar.db.setValue(COUNTER_ENTITY, "current", next, key);
    }

    return parts.prefix + String(next).padStart(parts.width, "0") + parts.suffix;
  });
}
