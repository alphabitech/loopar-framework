'use strict';

/**
 * Backups inside the running core: the maintenance gate (requests of a
 * tenant being restored or migrated get a 503), unplugging the tenant so it
 * re-initializes on the new data, and background jobs the desk follows by
 * polling.
 */

import { loopar, getTenantInstance, getOrCreateTenantInstance, evictTenantInstance } from '../loopar.js';
import { hookManager } from '../HookManager.js';
import { PermissionManager } from '../auth/PermissionManager.js';
import { requestContext } from '../server/router/request-context.js';
import { tenantRegistry } from '../server/tenant-registry.js';
import { createBackup, restoreBackup, listLocalBackups } from './engine.js';
import { readSettingsBare } from './settings.js';
import { migrateDatabase, MIGRATION_TARGETS } from '../db-migration/migrate.js';
import { fileSource } from '../db-migration/portable.js';

const maintenance = new Map(); // tenant → why it is closed ('restore' | 'migrate')
const jobs = new Map(); // tenant → { id, type, step, startedAt, finishedAt, ok, error, result }

/** Is this tenant closed for maintenance right now? (server.js answers its requests with a 503) */
export const isRestoring = (tenant) => maintenance.has(tenant);

/** Why the tenant is closed ('restore' | 'migrate'), or null when it is open. */
export const maintenanceReason = (tenant) => maintenance.get(tenant) ?? null;

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
      .catch((e) => {
        job.ok = false;
        job.error = e?.message || String(e);
        // Details the desk lists under the error (rejected values of a migration).
        if (e?.issues) job.issues = e.issues;
        if (e?.warnings) job.warnings = e.warnings;
        console.error(`[backup] ${type} of ${tenant} failed:`, e);
      })
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
    // Loopar's format: copied into a new database of the tenant's engine by
    // the same code that moves a tenant between engines (the export is the
    // source), while the tenant still runs on its current database.
    restorePortable: async (dir, { onStep: step }) => {
      const inst = await getOrCreateTenantInstance(tenant);
      if (inst && inst.__restoredAt === undefined) inst.__restoredAt = tenantRegistry.get(tenant)?.restoredAt ?? null;
      return await requestContext.run({ tenant: { name: tenant } }, async () => {
        const current = loopar.getDbConfig() || {};
        const dialect = String(current.dialect || '').toLowerCase();
        if (!MIGRATION_TARGETS.includes(dialect)) {
          throw Object.assign(new Error(`A backup in Loopar's format restores into ${MIGRATION_TARGETS.join(', ')}; "${tenant}" uses ${dialect || 'an unknown engine'}.`), { status: 400 });
        }
        const result = await migrateDatabase({
          from: fileSource(dir),
          target: { dialect, connection: current.connection || {} },
          apply: false,
          onStep: step,
        });
        return { config: result.config, database: result.database, previous: result.previous };
      });
    },
    beforeSwap: async (t) => {
      maintenance.set(t, 'restore');
      await new Promise((r) => setTimeout(r, DRAIN_MS));
      await unplugTenant(t);
    },
    afterSwap: async (t) => {
      tenantRegistry.invalidate();
      maintenance.delete(t);
    },
  }));
}

/**
 * Move a tenant's database to another engine, in the background (Tenant
 * Manager). A pre-migrate snapshot is taken first; the tenant answers
 * "maintenance" while its records are copied, then re-initializes on the new
 * database. With `test` the copy is made, checked and dropped, and the tenant
 * stays open on its current database the whole time.
 */
export function startMigrationJob({ root = process.cwd(), tenant, target, test = false }) {
  return startJob(tenant, test ? 'migration test' : 'migration', async (onStep) => {
    let snapshot = null;
    if (!test) {
      onStep('safety');
      const settings = await readSettingsBare(root, tenant);
      snapshot = (await createBackup({ root, tenant, kind: 'pre-migrate', settings, upload: false })).file;
      maintenance.set(tenant, 'migrate');
      await new Promise((r) => setTimeout(r, DRAIN_MS));
    }
    try {
      const inst = await getOrCreateTenantInstance(tenant);
      // Stamp it like server.js does for the instances it creates: otherwise
      // the tenant's next request (a test run keeps it open) takes it for a
      // stale, pre-restore instance and unplugs it — closing the database
      // the copy is reading.
      if (inst && inst.__restoredAt === undefined) inst.__restoredAt = tenantRegistry.get(tenant)?.restoredAt ?? null;
      const result = await requestContext.run({ tenant: { name: tenant } }, () =>
        migrateDatabase({ target, test, onStep }));
      if (!test) {
        // The instance still holds the old connection: the next request
        // initializes the tenant on the new database.
        await unplugTenant(tenant);
        tenantRegistry.invalidate();
      }
      return { ...result, snapshot };
    } finally {
      maintenance.delete(tenant);
    }
  });
}

const SAFETY_WINDOW_MS = 10 * 60 * 1000;

/**
 * Local snapshot of a tenant before an app is installed, updated or
 * uninstalled (Installer). One per 10 minutes: an update installs several
 * apps in a row. A failure never blocks the operation; it is returned
 * (`{ file, error }`) so the caller can say there is no snapshot to go back to.
 */
export async function safetySnapshot(tenant, note = null, root = process.cwd()) {
  try {
    const recent = listLocalBackups(root, tenant).find((b) => b.kind === 'pre-update');
    if (recent && Date.now() - recent.date.getTime() < SAFETY_WINDOW_MS) return { file: recent.file, error: null };
    const settings = await readSettingsBare(root, tenant);
    // A snapshot must not fail for a missing dump tool: "native" falls back to Loopar's format here.
    const format = settings.db_format === 'loopar' ? 'loopar' : 'auto';
    const result = await createBackup({ root, tenant, kind: 'pre-update', settings, upload: false, note, format });
    console.log(`[backup] snapshot before update: ${result.file}`);
    return { file: result.file, error: null };
  } catch (e) {
    console.warn(`[backup] snapshot before update failed (continuing): ${e.message}`);
    return { file: null, error: e.message || String(e) };
  }
}
