'use strict';

import { loopar } from 'loopar';
import { listBackups, readHead, backupJob, isRestoring, DESTINATIONS, NATIVE_REQUIRES, hasCommand, chooseFormat, dialectOf, readDbConfig } from 'loopar/core/backup/index.js';
import { backupSettings, tenantName } from './backup-service.js';

const scheduleText = (s) => (s.enabled
  ? `${s.frequency === 'weekly' ? `Every ${s.weekday}` : 'Every day'} at ${s.at} (server time)`
  : 'Off');

const toRow = (b) => withoutUndefined({
  file: b.file, kind: b.kind, date: b.date.toISOString(), size: b.size, encrypted: b.encrypted,
  local: b.local, remote: b.remote, note: b.manifest?.note ?? null, apps: b.manifest?.apps ?? null,
  framework: b.manifest?.framework?.version ?? null,
  // Lineage: the backup this one's state descends from. `undefined`: made
  // before lineage was recorded (the tree chains those by date).
  parent: b.manifest ? (b.manifest.parent === undefined ? undefined : b.manifest.parent) : undefined,
  // native: the engine's own dump (same engine, its tools); loopar: Loopar's format (any engine, nothing to install).
  database: b.manifest?.database
    ? { dialect: b.manifest.database.dialect, format: b.manifest.database.format || 'native', requires: b.manifest.database.requires ?? NATIVE_REQUIRES[b.manifest.database.dialect] ?? [] }
    : null,
});

/**
 * The page renders first from this object as is (SSR) and then from its JSON
 * (the AJAX refresh), which drops undefined keys: drop them here too so both
 * renders see the same row (`parent` absent ≠ `parent: null`).
 */
function withoutUndefined(o) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

/** This tenant's engine, the format its next backup takes and the engine tools this server has. */
function databaseInfo(tenant, settings) {
  try {
    const dialect = dialectOf(readDbConfig(process.cwd(), tenant));
    const tools = Object.fromEntries((NATIVE_REQUIRES[dialect] || []).map((t) => [t, hasCommand(t)]));
    return { dialect, nextFormat: chooseFormat(dialect, settings.db_format), chosen: settings.db_format, tools };
  } catch {
    return null;
  }
}

/**
 * Everything the Backups page shows. `remote: false` skips listing the
 * destination (fast first paint; the page asks for it right after).
 */
export async function pageData({ remote = true } = {}) {
  const tenant = tenantName();
  const settings = await backupSettings();
  const list = await listBackups({ tenant, settings, remote });
  const job = backupJob(tenant);
  return {
    tenant,
    user: loopar.auth?.user?.() ?? null,
    isAdministrator: (loopar.auth?.user?.() ?? null) === 'Administrator',
    settings: {
      enabled: !!settings.enabled,
      schedule: scheduleText(settings),
      encrypt: !!settings.encrypt,
      passphraseSet: !!settings.passphrase,
      destination: settings.destination,
      destinationLabel: settings.destination === 'local' ? 'This server only' : DESTINATIONS[settings.destination]?.label ?? settings.destination,
      includeFiles: !!settings.include_files,
      retention: { daily: settings.keep_daily, weekly: settings.keep_weekly, monthly: settings.keep_monthly },
      gdrive: settings.destination === 'gdrive'
        ? { configured: !!(settings.gdrive_client_id && settings.gdrive_client_secret), connected: !!settings.gdrive_refresh_token, account: settings.gdrive_account || null }
        : null,
    },
    rows: list.rows.map(toRow),
    database: databaseInfo(tenant, settings),
    // The backup the site's current state descends from ("you are here").
    head: readHead(process.cwd(), tenant),
    remoteListed: remote,
    remoteError: list.remoteError,
    job,
    restoring: isRestoring(tenant),
  };
}
