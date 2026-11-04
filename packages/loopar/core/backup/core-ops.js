'use strict';

/**
 * Backups inside the running core: the restore gate (requests of a tenant
 * being restored get a 503), unplugging the tenant so it re-initializes on
 * the restored data, and background jobs the desk follows by polling.
 */

import { getTenantInstance, evictTenantInstance } from '../loopar.js';
import { hookManager } from '../HookManager.js';
import { PermissionManager } from '../auth/PermissionManager.js';
import { requestContext } from '../server/router/request-context.js';
import { tenantRegistry } from '../server/tenant-registry.js';
import { createBackup, restoreBackup, listLocalBackups } from './engine.js';
import { readSettingsBare } from './settings.js';

const restoring = new Set();
const jobs = new Map(); // tenant → { id, type, step, startedAt, finishedAt, ok, error, result }

/** Is this tenant being restored right now? (server.js answers its requests with a 503) */
export const isRestoring = (tenant) => restoring.has(tenant);

/**
 * Close a tenant's connections and drop its in-memory state (hooks, cached
 * permissions, the instance), so the next request initializes it from what
 * is now on disk.
 */
export async function unplugTenant(name) {
  const inst = getTenantInstance(name);
  if (!inst) return;
  await requestContext.run({ tenant: { name } }, async () => {
    try { await inst.db?.close?.(); } catch { /* already closed */ }
    try { PermissionManager.invalidate(); } catch { /* nothing cached */ }
  });
  hookManager.unregisterTenant(name);
  evictTenantInstance(name);
}

/** Requests already inside the tenant get a moment to finish before its DB closes. */
const DRAIN_MS = 1500;

/** The tenant's current/last background job (null when none ran since the core started). */
export const backupJob = (tenant) => jobs.get(tenant) ?? null;

function startJob(tenant, type, fn) {
  const current = jobs.get(tenant);
  if (current && !current.finishedAt) {
    throw Object.assign(new Error(`A ${current.type} of this site is already running.`), { status: 409 });
  }
  const job = { id: `${Date.now().toString(36)}`, type, step: 'starting', startedAt: new Date().toISOString(), finishedAt: null, ok: null, error: null, result: null };
  jobs.set(tenant, job);
  const onStep = (step) => { job.step = step; };
  // Detached from the request: a restore outlives the tenant's own requests.
  setImmediate(() => {
    fn(onStep)
      .then((result) => { job.ok = true; job.result = result; })
      .catch((e) => { job.ok = false; job.error = e?.message || String(e); console.error(`[backup] ${type} of ${tenant} failed:`, e); })
      .finally(() => { job.finishedAt = new Date().toISOString(); job.step = 'done'; });
  });
  return job;
}

/** Back up a tenant in the background (desk "Backup now"). */
export function startBackupJob({ root = process.cwd(), tenant, settings, kind = 'manual' }) {
  return startJob(tenant, 'backup', (onStep) => createBackup({ root, tenant, kind, settings, onStep }));
}

/**
 * Restore a tenant in place, in the background: snapshot, gate its
 * requests, swap the files/DB, re-initialize on the next request.
 */
export function startRestoreJob({ root = process.cwd(), tenant, file, passphrase, settings }) {
  return startJob(tenant, 'restore', (onStep) => restoreBackup({
    root, tenant, file, passphrase, settings, mode: 'replace', requireMadeHere: true, onStep,
    beforeSwap: async (t) => {
      restoring.add(t);
      await new Promise((r) => setTimeout(r, DRAIN_MS));
      await unplugTenant(t);
    },
    afterSwap: async (t) => {
      tenantRegistry.invalidate();
      restoring.delete(t);
    },
  }));
}

const SAFETY_WINDOW_MS = 10 * 60 * 1000;

/**
 * Local snapshot of a tenant before an app is installed or updated
 * (Installer.install). One per 10 minutes: an update installs several apps
 * in a row. A failure never blocks the update — it is logged.
 */
export async function safetySnapshot(tenant, note = null, root = process.cwd()) {
  try {
    const recent = listLocalBackups(root, tenant).find((b) => b.kind === 'pre-update');
    if (recent && Date.now() - recent.date.getTime() < SAFETY_WINDOW_MS) return recent.file;
    const settings = await readSettingsBare(root, tenant);
    const result = await createBackup({ root, tenant, kind: 'pre-update', settings, upload: false, note });
    console.log(`[backup] snapshot before update: ${result.file}`);
    return result.file;
  } catch (e) {
    console.warn(`[backup] snapshot before update failed (continuing): ${e.message}`);
    return null;
  }
}
