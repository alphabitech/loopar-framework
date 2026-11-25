'use strict';

/**
 * Data-integrity mode of a tenant, from sites/<tenant>/config.json
 * (`"integrity": "warn"`). Default: strict.
 *
 *   - strict: the ORM refuses writes that break integrity (missing link
 *     targets, deletes of referenced records, locked submitted records) and
 *     the database carries the foreign keys (PostgreSQL / MySQL).
 *   - warn: the same checks only log what they would refuse, and the
 *     framework's foreign keys are removed. For a tenant whose existing data
 *     still has to be cleaned up (see `yarn integrity <tenant>`).
 */

import { loopar } from '../loopar.js';
import { tenant } from '../../bin/tenant/tenant-builder.js';

export const INTEGRITY = Object.freeze({ STRICT: 'strict', WARN: 'warn' });

const TTL_MS = 5000;
const cache = new Map(); // tenant → { mode, at }

/** The integrity mode of `tenantName` (the current tenant by default). */
export function integrityMode(tenantName = loopar.tenantId) {
  if (!tenantName) return INTEGRITY.STRICT;
  const hit = cache.get(tenantName);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.mode;
  let mode = INTEGRITY.STRICT;
  try {
    mode = tenant.readTenant(tenantName)?.integrity === INTEGRITY.WARN ? INTEGRITY.WARN : INTEGRITY.STRICT;
  } catch { /* unreadable config: strict */ }
  cache.set(tenantName, { mode, at: Date.now() });
  return mode;
}

/** Forgets the cached modes (a config.json just changed). */
export function resetIntegrityModeCache() {
  cache.clear();
}

export const isStrict = (tenantName) => integrityMode(tenantName) === INTEGRITY.STRICT;

/**
 * Refuses (strict) or logs (warn) an integrity violation. `error` is what
 * loopar.throw takes; `log` a one-line summary for the warning.
 */
export function violation(error, log = typeof error === 'string' ? error : error?.message) {
  if (isStrict()) return loopar.throw(error);
  const plain = String(log || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  console.warn(`[integrity:warn] ${loopar.tenantId || ''}: ${plain}`);
}
