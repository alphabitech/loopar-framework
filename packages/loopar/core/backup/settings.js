'use strict';

/**
 * Backup Settings of a tenant read WITHOUT the framework (CLI, TUI): the
 * single's rows in `Document Single Values`, its password fields decrypted
 * with the tenant key — the same derivation Loopar uses (LOOPAR_SECRET_KEY
 * salted by tenant, else sites/<tenant>/config.json → secretKey).
 *
 * Inside the core, prefer `loopar.getDocument('Backup Settings')`; this
 * module exists so a tenant that won't boot can still be backed up and
 * restored from the terminal.
 */

import fs from 'node:fs';
import path from 'node:path';
import { deriveSecretKey, decryptSecret, isEncryptedSecret } from '../global/secrets.js';
import { openKnex, siteDir } from './database.js';

export const SETTINGS_DOCUMENT = 'Backup Settings';

/** Field names, defaults and which ones are secrets — the entity's schema in one place. */
export const SETTINGS_DEFAULTS = Object.freeze({
  enabled: 0,
  frequency: 'daily',
  at: '02:30',
  weekday: 'sun',
  keep_daily: 7,
  keep_weekly: 4,
  keep_monthly: 3,
  include_files: 1,
  encrypt: 1,
  passphrase: '',
  destination: 'local',
  s3_endpoint: '', s3_region: 'us-east-1', s3_bucket: '', s3_access_key: '', s3_secret_key: '', s3_prefix: 'loopar-backups',
  sftp_host: '', sftp_port: 22, sftp_username: '', sftp_password: '', sftp_key_path: '', sftp_path: 'loopar-backups',
  webdav_url: '', webdav_username: '', webdav_password: '',
  gdrive_client_id: '', gdrive_client_secret: '', gdrive_refresh_token: '', gdrive_folder_id: '', gdrive_account: '',
});

export const SECRET_FIELDS = new Set(['passphrase', 's3_secret_key', 'sftp_password', 'webdav_password', 'gdrive_client_secret', 'gdrive_refresh_token']);

function tenantKey(root, tenant) {
  const master = process.env.LOOPAR_SECRET_KEY;
  if (master) return deriveSecretKey(master, tenant);
  const cfg = JSON.parse(fs.readFileSync(path.join(siteDir(root, tenant), 'config.json'), 'utf8'));
  if (!cfg.secretKey) throw new Error(`Tenant "${tenant}" has no secretKey in config.json.`);
  return deriveSecretKey(cfg.secretKey);
}

/** Normalize raw values (strings from the EAV table or a document) into typed settings. */
export function normalizeSettings(raw = {}) {
  const s = { ...SETTINGS_DEFAULTS };
  for (const k of Object.keys(SETTINGS_DEFAULTS)) {
    if (raw[k] !== undefined && raw[k] !== null && raw[k] !== '') s[k] = raw[k];
  }
  for (const k of ['enabled', 'include_files', 'encrypt']) s[k] = [1, '1', true, 'true'].includes(s[k]) ? 1 : 0;
  for (const k of ['keep_daily', 'keep_weekly', 'keep_monthly', 'sftp_port']) s[k] = Number(s[k]) || SETTINGS_DEFAULTS[k];
  s.destination = String(s.destination || 'local').toLowerCase();
  return s;
}

/** The tenant's Backup Settings (defaults when the single was never saved or the table is missing). */
export async function readSettingsBare(root, tenant) {
  let knex;
  try {
    knex = openKnex(root, tenant, { readonly: true });
    const rows = await knex('Document Single Values').select('field', 'value').where({ document: SETTINGS_DOCUMENT });
    const raw = {};
    let key = null;
    for (const { field, value } of rows) {
      if (SECRET_FIELDS.has(field) && isEncryptedSecret(value)) {
        key ??= tenantKey(root, tenant);
        try { raw[field] = decryptSecret(value, key); } catch { raw[field] = ''; }
      } else {
        raw[field] = value;
      }
    }
    return normalizeSettings(raw);
  } catch {
    return normalizeSettings({});
  } finally {
    await knex?.destroy().catch(() => {});
  }
}
