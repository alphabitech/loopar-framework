'use strict';

/**
 * Backups over pm2's process messages — how the terminal Tenant Manager (TUI)
 * asks the RUNNING core to restore, so a terminal restore is the very same
 * job the desk's Backups page runs (requests gated, tenant unplugged and
 * re-initialized, Loopar's format copied with the framework's own code).
 *
 * Only someone who can talk to this project's pm2 daemon (same OS user,
 * PM2_HOME = <root>/.pm2) can send these — the same trust as a shell on the
 * server, so no further auth is asked.
 *
 * Request  (pm2 sendDataToProcessId): { topic: 'loopar:backup', data: { id, op, tenant, file?, passphrase? } }
 * Reply    (process.send → pm2 bus):  { type: 'process:msg', data: { topic: 'loopar:backup:reply', id, ok, job?, error? } }
 *          (pm2 forwards only `data` to the bus, so the topic travels inside it)
 * ops: restore → starts the job; job → the tenant's current/last job (poll until finishedAt).
 */

import { startRestoreJob, backupJob } from './core-ops.js';
import { readSettingsBare } from './settings.js';

export const BACKUP_IPC_TOPIC = 'loopar:backup';

let installed = false;

export function installBackupIpc() {
  if (installed || typeof process.send !== 'function') return; // not under pm2
  installed = true;
  process.on('message', async (packet) => {
    if (packet?.topic !== BACKUP_IPC_TOPIC) return;
    const { id, op, tenant, file, passphrase } = packet.data || {};
    const reply = (data) => {
      try { process.send({ type: 'process:msg', data: { topic: `${BACKUP_IPC_TOPIC}:reply`, id, ...data } }); }
      catch { /* the requester went away */ }
    };
    try {
      if (!tenant) throw new Error('tenant is required');
      if (op === 'restore') {
        const settings = await readSettingsBare(process.cwd(), tenant);
        const job = startRestoreJob({ tenant, file, passphrase: passphrase || undefined, settings });
        return reply({ ok: true, job: { ...job } });
      }
      if (op === 'job') {
        const job = backupJob(tenant);
        return reply({ ok: true, job: job ? { ...job } : null });
      }
      reply({ ok: false, error: `unknown op "${op}"` });
    } catch (e) {
      reply({ ok: false, error: e?.message || String(e) });
    }
  });
}
