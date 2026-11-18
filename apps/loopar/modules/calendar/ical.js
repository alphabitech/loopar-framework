'use strict';

/*
 * iCalendar (RFC 5545) text of a calendar's events: what phone and desktop
 * calendars (Google, Apple, Outlook) read when they subscribe to a feed URL.
 * Pure: rows in, text out.
 *
 * Times are the site's wall clock, written with its time zone (TZID), so a
 * weekly event keeps its weekday for every subscriber; all-day events are
 * plain dates. A recurring event is one VEVENT with an RRULE.
 */

import { addDays, dayOf, weekdaysOf } from 'loopar/core/global/calendar.js';

const CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const FREQ = { daily: 'DAILY', weekly: 'WEEKLY', monthly: 'MONTHLY', yearly: 'YEARLY' };
const truthy = (value) => [1, '1', true, 'true'].includes(value);

const escapeText = (value) => String(value ?? '')
  .replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

/** `YYYY-MM-DD HH:mm:ss` → `YYYYMMDDTHHMMSS`; a day → `YYYYMMDD`. */
const compact = (value) => String(value).replace(/[-:]/g, '').replace(' ', 'T');
const utcStamp = (date) => `${date.toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`;

/** Lines longer than 75 characters continue on the next one, after a space. */
function fold(line) {
  const parts = [];
  for (let rest = line; rest.length; rest = rest.slice(parts.length ? 74 : 75)) parts.push(rest.slice(0, parts.length ? 74 : 75));
  return parts.join('\r\n ');
}

function rrule(event, allDay, toInstant) {
  const freq = FREQ[String(event.repeat ?? '').trim().toLowerCase()];
  if (!freq) return null;
  const parts = [`FREQ=${freq}`];
  const interval = Math.max(1, parseInt(event.repeat_interval, 10) || 1);
  if (interval > 1) parts.push(`INTERVAL=${interval}`);
  if (freq === 'WEEKLY') {
    const days = weekdaysOf(event.repeat_days).map((d) => CODES[d]);
    if (days.length) parts.push(`BYDAY=${days.join(',')}`);
  }
  const until = dayOf(event.repeat_until);
  // With a timed start, UNTIL is an instant (UTC): the end of that day on the site's clock.
  if (until) parts.push(`UNTIL=${allDay ? compact(until) : utcStamp(toInstant(`${until} 23:59:59`))}`);
  return parts.join(';');
}

/**
 * `events`: rows with `name`, `title`, `starts_at`, `ends_at` (wall clock,
 * `YYYY-MM-DD HH:mm:ss`), `all_day`, `location`, `description` and the
 * `repeat*` fields. `toInstant` turns a wall-clock time of the site into a
 * Date (the server's own zone by default).
 */
export function buildICal({ name, events = [], timeZone = 'UTC', host = 'loopar', now = new Date(), toInstant = (local) => new Date(local.replace(' ', 'T')) }) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Loopar//Calendar//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(name)}`,
    `X-WR-TIMEZONE:${timeZone}`,
  ];

  for (const event of events) {
    const start = String(event.starts_at || '');
    const startDay = dayOf(start);
    if (!startDay) continue;
    const end = String(event.ends_at || '');
    const endDay = dayOf(end);
    const allDay = truthy(event.all_day);

    lines.push('BEGIN:VEVENT', `UID:${event.name}@${host}`, `DTSTAMP:${utcStamp(now)}`);
    if (allDay) {
      lines.push(`DTSTART;VALUE=DATE:${compact(startDay)}`);
      // DTEND is exclusive: the day after the last one.
      lines.push(`DTEND;VALUE=DATE:${compact(addDays(endDay && endDay > startDay ? endDay : startDay, 1))}`);
    } else {
      lines.push(`DTSTART;TZID=${timeZone}:${compact(start.slice(0, 19))}`);
      if (endDay && end > start) lines.push(`DTEND;TZID=${timeZone}:${compact(end.slice(0, 19))}`);
    }
    const rule = rrule(event, allDay, toInstant);
    if (rule) lines.push(`RRULE:${rule}`);
    lines.push(`SUMMARY:${escapeText(event.title || event.name)}`);
    if (event.location) lines.push(`LOCATION:${escapeText(event.location)}`);
    if (event.description) lines.push(`DESCRIPTION:${escapeText(event.description)}`);
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}
