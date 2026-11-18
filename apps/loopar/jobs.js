'use strict';

/**
 * Scheduled jobs of the loopar app (see core/global/scheduler.js).
 *
 * event-reminders — every 5 minutes; emails the reminders of the calendar
 * events that are due (Event.reminder).
 *
 * saved-view-emails — hourly check; emails the saved views of lists whose
 * schedule (daily, weekly, monthly) is due. See core/document/saved-views.js.
 *
 * backup — hourly check; backs the site up once the time set in Backup
 * Settings has passed (daily or weekly). Off until enabled there.
 */
export default [
  {
    name: 'event-reminders',
    label: 'Event reminders',
    schedule: { every: 'minutes', interval: 5 },
    run: async () => {
      const { sendEventReminders } = await import('./modules/calendar/calendar.js');
      return await sendEventReminders();
    },
  },
  {
    name: 'saved-view-emails',
    label: 'Saved view emails',
    schedule: { every: 'hourly', minute: 10 },
    run: async () => {
      const { sendScheduledViews } = await import('loopar');
      return await sendScheduledViews();
    },
  },
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
