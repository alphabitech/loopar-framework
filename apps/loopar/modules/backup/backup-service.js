'use strict';

/**
 * Backups of the current tenant, inside the core: settings read through the
 * Backup Settings document (decrypted with the tenant key), status written
 * back to it, the scheduled run and the safety snapshot taken before an app
 * is installed or updated. The engine itself lives in core/backup.
 */

import { loopar } from 'loopar';
import {
  createBackup, listLocalBackups, normalizeSettings, lastSlot, SETTINGS_DEFAULTS, SETTINGS_DOCUMENT, SECRET_FIELDS,
} from 'loopar/core/backup/index.js';

export const tenantName = () => loopar.requestTenantId;

/** The tenant's Backup Settings, typed (defaults when never saved). */
export async function backupSettings() {
  if (!loopar.getRef(SETTINGS_DOCUMENT, false)) return normalizeSettings({});
  const doc = await loopar.getDocument(SETTINGS_DOCUMENT);
  const raw = {};
  for (const key of Object.keys(SETTINGS_DEFAULTS)) raw[key] = doc[key];
  return normalizeSettings(raw);
}

/** Write fields of the single directly (no validation round-trip); secrets are encrypted. */
export async function saveSettingsFields(fields) {
  const data = {};
  for (const [k, v] of Object.entries(fields)) data[k] = SECRET_FIELDS.has(k) && v ? loopar.encryptSecret(String(v)) : (v ?? '');
  await loopar.db.insertRow(SETTINGS_DOCUMENT, data, true);
}

export async function recordStatus({ status, file = '', message = '' }) {
  try {
    await saveSettingsFields({
      last_backup_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
      last_backup_status: status,
      last_backup_file: file,
      last_backup_message: String(message || '').slice(0, 2000),
    });
  } catch (e) {
    console.warn('[backup] could not record status:', e.message);
  }
}

/** Run a backup of the current tenant and record the outcome in Backup Settings. */
export async function runBackup({ kind = 'manual', settings, onStep } = {}) {
  settings ??= await backupSettings();
  try {
    const result = await createBackup({ tenant: tenantName(), kind, settings, onStep });
    const remote = result.remote.destination
      ? (result.remote.ok ? ` · copied to ${result.remote.destination}` : ` · NOT copied to ${result.remote.destination}: ${result.remote.error}`)
      : '';
    await recordStatus({
      status: result.remote.ok === false ? 'Partial' : 'Success',
      file: result.file,
      message: `${(result.size / 1024 / 1024).toFixed(2)} MB${result.encrypted ? ', encrypted' : ''}${remote}${result.pruned.length ? ` · pruned ${result.pruned.length}` : ''}`,
    });
    return result;
  } catch (e) {
    await recordStatus({ status: 'Failed', message: e.message });
    throw e;
  }
}

/** Scheduler entry (apps/loopar/jobs.js, hourly): back up when the configured slot has passed. */
export async function runScheduledBackup(now = new Date()) {
  if (!loopar.getRef(SETTINGS_DOCUMENT, false)) return 'Backup Settings not installed yet';
  const settings = await backupSettings();
  if (!settings.enabled) return 'Automatic backups are off';
  const slot = lastSlot(settings, now);
  const last = listLocalBackups(process.cwd(), tenantName()).find((b) => b.kind === 'scheduled');
  if (last && last.date >= slot) return `Up to date (last ${last.file})`;
  const result = await runBackup({ kind: 'scheduled', settings });
  return `${result.file}${result.remote.ok === false ? ` (remote copy failed: ${result.remote.error})` : ''}`;
}
