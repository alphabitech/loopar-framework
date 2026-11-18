'use strict';

import { BaseDocument, loopar } from 'loopar';
import { minutesOf, durationsOf } from '../../booking.js';

export const CALENDAR_COLORS = ['blue', 'amber', 'green', 'red', 'violet', 'gray'];

/**
 * Calendar: a named, colored group of Events ("General", "Installations",
 * "Classes"…). Events of a disabled calendar stay stored but are not drawn.
 * With "Public booking" on, visitors book free times of its business hours
 * from the website (../../booking.js).
 */
export default class Calendar extends BaseDocument {
  constructor(props) {
    super(props);
  }

  async beforeSave() {
    this.name = String(this.name ?? '').trim().replace(/\s+/g, ' ');
    if (!this.name) loopar.throw('The calendar needs a name.');
    if (!CALENDAR_COLORS.includes(this.color)) this.color = CALENDAR_COLORS[0];

    // Booking: what is written must read back as a rule (see ../../booking.js).
    for (const field of ['booking_from', 'booking_to']) {
      const value = String(this[field] ?? '').trim();
      if (value && minutesOf(value) === null) loopar.throw(`"${field === 'booking_from' ? 'Opens at' : 'Closes at'}" must be a 24-hour time like 09:00.`);
      this[field] = value || null;
    }
    const from = minutesOf(this.booking_from), to = minutesOf(this.booking_to);
    if (from !== null && to !== null && to <= from) loopar.throw('"Closes at" must be after "Opens at".');
    const durations = String(this.booking_durations ?? '').trim();
    if (durations && !durationsOf(durations).length) loopar.throw('"Durations" must be minutes separated by commas, like 30, 60.');
    this.booking_durations = durations ? durationsOf(durations).join(', ') : null;
  }
}
