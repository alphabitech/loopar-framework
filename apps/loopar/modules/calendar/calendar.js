'use strict';

/*
 * Calendar helpers for apps and for the Event entity.
 *
 * An Event may be related to any record through `document` / `document_name`
 * (the record it was scheduled from: a project, a quote, a member…). Apart
 * from Events, every entity with date fields shows on the calendar by
 * convention (packages/loopar/core/global/calendar.js) as a layer.
 */

import { loopar, Op } from 'loopar';
import { PermissionManager } from 'loopar/core/auth/PermissionManager.js';
import { multipleValues } from 'loopar/core/global/element-definition.js';
import { addDays, occurrenceDays } from 'loopar/core/global/calendar.js';

export const EVENT = 'Event';
export const CALENDAR = 'Calendar';
export const DEFAULT_CALENDAR = 'General';

/** Minutes before the start each `reminder` option fires. */
export const REMINDER_MINUTES = {
  'At start': 0,
  '10 minutes before': 10,
  '30 minutes before': 30,
  '1 hour before': 60,
  '1 day before': 1440,
};
// A reminder still goes out this long after its moment (a tick missed, "At start").
const REMINDER_GRACE = 15;

const DATE_TIME = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/;

/** `YYYY-MM-DD HH:mm:ss` of a stored or submitted date-time (a Date, or text), or null. */
export function toDateTime(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) {
    if (isNaN(value.getTime())) return null;
    const p = (n) => String(n).padStart(2, '0');
    return `${value.getFullYear()}-${p(value.getMonth() + 1)}-${p(value.getDate())} ${p(value.getHours())}:${p(value.getMinutes())}:${p(value.getSeconds())}`;
  }
  const text = String(value).trim();
  // A value with a time zone (what the form's picker sends) is an instant:
  // stored as the server's wall clock, like every date_time field.
  if (/\d{2}:\d{2}(:\d{2}(\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})$/i.test(text)) return toDateTime(new Date(text));
  const m = text.match(DATE_TIME);
  if (!m || isNaN(Date.parse(`${m[1]}T00:00:00Z`))) return null;
  return `${m[1]} ${m[2] || '00'}:${m[3] || '00'}:${m[4] || '00'}`;
}

/** `value` (`YYYY-MM-DD HH:mm:ss`) plus `minutes`, in the same wall-clock format. */
export function addMinutes(value, minutes) {
  const ms = Date.parse(`${value.replace(' ', 'T')}Z`) + minutes * 60000;
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/** True when the calendar module is installed in this tenant. */
export const calendarAvailable = () => !!loopar.getRef(EVENT, false);

/**
 * Schedules an Event (`title`, `starts_at`, and optionally `ends_at`,
 * `all_day`, `calendar`, `location`, `description`, `contact_*`) related to record
 * `documentName` of `document`. `booking: true` marks it as booked by a
 * visitor (`source`). Returns the event name.
 */
export async function scheduleEvent(data = {}, { document = null, documentName = null, booking = false } = {}) {
  const doc = await loopar.newDocument(EVENT);
  for (const field of ['title', 'starts_at', 'ends_at', 'all_day', 'calendar', 'location', 'description', 'contact_name', 'contact_email', 'contact_phone']) {
    if (data[field] !== undefined && data[field] !== null) doc[field] = data[field];
  }
  doc.document = document;
  doc.document_name = documentName;
  if (booking) {
    doc.source = 'Booking';
    // Read by Event.beforeSave: a form can't claim to be a booking.
    doc.__FROM_BOOKING__ = true;
  }
  await doc.save();
  return doc.name;
}

/**
 * Layers of the calendar for `user`: the business entities with date fields
 * (`__CALENDAR__` of its ref) whose list the user may see. Events come first.
 */
export function calendarLayers(user = loopar.auth?.user?.()) {
  const layers = [];
  for (const ref of Object.values(loopar.getRefs() || {})) {
    const calendar = ref?.__CALENDAR__;
    if (!calendar || ref.__ENTITY__ !== 'Entity' || ref.is_single || ref.is_child || ref.is_virtual) continue;
    if (ref.__NAME__ === CALENDAR) continue;
    // Business records only: logs and app-written records (no history, read-only)
    // would flood the calendar, and so would a lone timestamp (sent at, paid at…) —
    // a date_time entity needs a start/end pair to be a layer.
    if (ref.__NAME__ !== EVENT && (!ref.enable_history || ref.read_only || (calendar.time && !calendar.end))) continue;
    if (!PermissionManager.can(ref.__NAME__, 'list', user)) continue;
    layers.push({
      entity: ref.__NAME__,
      module: ref.__MODULE__ || null,
      ...calendar,
      editable: calendar.editable && !ref.read_only && PermissionManager.can(ref.__NAME__, 'update', user),
      creatable: !ref.read_only && PermissionManager.can(ref.__NAME__, 'create', user),
    });
  }
  return layers.sort((a, b) => (b.entity === EVENT) - (a.entity === EVENT) || a.entity.localeCompare(b.entity));
}

const escapeHTML = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const truthy = (value) => [1, '1', true, 'true'].includes(value);

/** Emails of the users an event is for: the assigned ones, else whoever created it. */
async function reminderRecipients(row) {
  const assigned = multipleValues(row.assigned_to).filter(Boolean);
  const names = assigned.length ? assigned : [row.__created_by__].filter(Boolean);
  if (!names.length) return [];
  const users = await loopar.db.getAll('User', ['name', 'email', 'disabled'], { name: { [Op.in]: names } });
  return [...new Set(users.filter((u) => !truthy(u.disabled) && u.email).map((u) => String(u.email).trim()))];
}

/** The occurrence of `row` whose reminder is due at `now` (`YYYY-MM-DD HH:mm:ss`), or null. */
function dueOccurrence(row, calendar, now) {
  const lead = REMINDER_MINUTES[row.reminder];
  const first = toDateTime(row.starts_at);
  if (lead === undefined || !first) return null;
  const time = truthy(row.all_day) ? '00:00:00' : first.slice(11);
  const today = now.slice(0, 10);

  for (const day of occurrenceDays(row, calendar, addDays(today, -1), addDays(today, 2))) {
    const start = `${day} ${time}`;
    const remindAt = addMinutes(start, -lead);
    const closes = addMinutes(remindAt, Math.max(lead, REMINDER_GRACE));
    if (remindAt <= now && now < closes && toDateTime(row.reminded_for) !== start) return start;
  }
  return null;
}

/**
 * Sends the reminders due now (job "event-reminders", every 5 minutes): one
 * email per event occurrence, to its users. `reminded_for` records the
 * occurrence so it is sent once. Returns a summary for the job log.
 */
export async function sendEventReminders(now = new Date()) {
  const calendar = loopar.getRef(EVENT, false)?.__CALENDAR__;
  if (!calendar) return 'calendar not installed';

  const nowText = toDateTime(now);
  const today = nowText.slice(0, 10);
  const rows = await loopar.db.query(EVENT)
    .whereNull('__deleted_at__')
    .whereIn('reminder', Object.keys(REMINDER_MINUTES))
    .where('starts_at', '<=', `${addDays(today, 2)} 23:59:59`)
    .where((w) => w
      .where('starts_at', '>=', `${addDays(today, -1)} 00:00:00`)
      .orWhere((r) => r.whereIn('repeat', ['Daily', 'Weekly', 'Monthly', 'Yearly'])
        .where((u) => u.whereNull('repeat_until').orWhere('repeat_until', '>=', addDays(today, -1)))))
    .select('*');

  let sent = 0, failed = 0, nobody = 0;
  for (const row of rows) {
    const start = dueOccurrence(row, calendar, nowText);
    if (!start) continue;

    const to = await reminderRecipients(row);
    if (to.length) {
      const when = truthy(row.all_day) ? start.slice(0, 10) : start.slice(0, 16);
      try {
        await loopar.mail.send({
          to,
          subject: `Reminder: ${row.title}`,
          html: `<p><strong>${escapeHTML(row.title)}</strong></p>`
            + `<p>${escapeHTML(when)}${row.location ? ` · ${escapeHTML(row.location)}` : ''}</p>`
            + (row.description ? `<p>${escapeHTML(row.description).replace(/\n/g, '<br>')}</p>` : '')
            + (row.document && row.document_name ? `<p>${escapeHTML(row.document)}: ${escapeHTML(row.document_name)}</p>` : ''),
        });
        sent++;
      } catch (error) {
        // Not marked: the next tick tries again while the reminder is still due.
        console.error(`[calendar] reminder of ${row.name} failed:`, error.message);
        failed++;
        continue;
      }
    } else {
      nobody++;
    }
    // Plain column write: a reminder is not an edit of the event (no history, no version bump).
    await loopar.db.query(EVENT).where({ name: row.name }).update({ reminded_for: start });
  }

  return [`${sent} reminder(s) sent`, failed && `${failed} failed`, nobody && `${nobody} without recipients`].filter(Boolean).join('; ');
}
