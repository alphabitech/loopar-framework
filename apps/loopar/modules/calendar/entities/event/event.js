'use strict';

import { BaseDocument, loopar } from 'loopar';
import { CALENDAR, DEFAULT_CALENDAR, REMINDER_MINUTES, toDateTime, addMinutes } from '../../calendar.js';

const clean = (value) => String(value ?? '').trim().replace(/\s+/g, ' ');
const truthy = (value) => [1, '1', true, 'true'].includes(value);
const REPEATS = ['None', 'Daily', 'Weekly', 'Monthly', 'Yearly'];
const REMINDERS = ['None', ...Object.keys(REMINDER_MINUTES)];

/**
 * Event: something that happens at a time — a visit, a meeting, a class, a
 * delivery. It belongs to a Calendar (its color) and may be related to any
 * record through `document` / `document_name` (the record it was scheduled
 * from; see ../../calendar.js).
 *
 * Times are wall-clock (`YYYY-MM-DD HH:mm:ss`). An all-day event keeps
 * midnight on both ends, and its end is the last day it covers.
 *
 * `repeat` (+ `repeat_interval`, `repeat_days`, `repeat_until`) makes it
 * recurring: one record, drawn once per repetition by the calendar.
 *
 * `assigned_to` are the users it is for; `reminder` emails them before each
 * occurrence (job "event-reminders"), and `reminded_for` keeps the start of
 * the last occurrence already reminded.
 */
export default class Event extends BaseDocument {
  constructor(props) {
    super(props);
  }

  async beforeSave() {
    this.title = clean(this.title);
    if (!this.title) loopar.throw('The event needs a title.');

    let start = toDateTime(this.starts_at);
    if (!start) loopar.throw('The event needs a start.');
    let end = toDateTime(this.ends_at);

    this.all_day = truthy(this.all_day) ? 1 : 0;
    if (this.all_day) {
      start = `${start.slice(0, 10)} 00:00:00`;
      end = `${(end && end > start ? end : start).slice(0, 10)} 00:00:00`;
    } else {
      if (end && end < start) loopar.throw('"Ends" must be after "Starts".');
      if (!end || end === start) end = addMinutes(start, 60);
    }
    this.starts_at = start;
    this.ends_at = end;

    // Recurrence: without a frequency the event happens once and keeps no leftovers.
    this.repeat = REPEATS.includes(this.repeat) ? this.repeat : 'None';
    if (this.repeat === 'None') {
      this.repeat_interval = 1;
      this.repeat_days = '[]';
      this.repeat_until = null;
    } else {
      this.repeat_interval = Math.min(999, Math.max(1, parseInt(this.repeat_interval, 10) || 1));
      if (this.repeat !== 'Weekly') this.repeat_days = '[]';
      const until = toDateTime(this.repeat_until);
      if (until && until.slice(0, 10) < start.slice(0, 10)) loopar.throw('"Until" must be on or after the start.');
      this.repeat_until = until ? until.slice(0, 10) : null;
    }

    this.reminder = REMINDERS.includes(this.reminder) ? this.reminder : 'None';
    // Where the event came from: only the booking flow says "Booking" (../../calendar.js).
    // The form can't change it: a new event is a booking only when the flow says
    // so, and a stored one keeps what it was.
    const booked = this.__IS_NEW__
      ? this.__FROM_BOOKING__ === true
      : await loopar.db.getValue('Event', 'source', this.__DOCUMENT_NAME__, { ifNotFound: null }) === 'Booking';
    this.source = booked ? 'Booking' : 'Manual';

    this.calendar = clean(this.calendar) || null;
    if (!this.calendar && await loopar.db.getRow(CALENDAR, DEFAULT_CALENDAR, ['name'])) this.calendar = DEFAULT_CALENDAR;

    this.document = clean(this.document) || null;
    this.document_name = clean(this.document_name) || null;
    if (this.document && !loopar.getRef(this.document, false)) loopar.throw(`${this.document} is not an entity of this site.`);
  }
}
