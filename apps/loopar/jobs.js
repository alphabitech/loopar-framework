'use strict';

/**
 * Scheduled jobs of the loopar app (see core/global/scheduler.js).
 *
 * backup — hourly check; backs the site up once the time set in Backup
 * Settings has passed (daily or weekly). Off until enabled there.
 */
export default [
  {
    name: 'backup',
    label: 'Backups',
    schedule: { every: 'hourly', minute: 5 },
    run: async () => {
      const { runScheduledBackup } = await import('./modules/backup/backup-service.js');
      return await runScheduledBackup();
    },
  },
];
