'use strict';

import { loopar } from 'loopar';
import { listBackups, backupJob, isRestoring, DESTINATIONS } from 'loopar/core/backup/index.js';
import { backupSettings, tenantName } from './backup-service.js';

const scheduleText = (s) => (s.enabled
  ? `${s.frequency === 'weekly' ? `Every ${s.weekday}` : 'Every day'} at ${s.at} (server time)`
  : 'Off');

const toRow = (b) => ({
  file: b.file, kind: b.kind, date: b.date.toISOString(), size: b.size, encrypted: b.encrypted,
  local: b.local, remote: b.remote, note: b.manifest?.note ?? null, apps: b.manifest?.apps ?? null,
  framework: b.manifest?.framework?.version ?? null,
});

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
    remoteListed: remote,
    remoteError: list.remoteError,
    job,
    restoring: isRestoring(tenant),
  };
}
