'use strict';

/*
 * Public booking of a calendar: the free times of a day, from the calendar's
 * business hours and the events it already has. Pure: times are the site's
 * wall clock (`YYYY-MM-DD HH:mm:ss`).
 */

import { occurrenceDays, addDays, diffDays, dayOf, weekdaysOf } from 'loopar/core/global/calendar.js';

export const DEFAULT_BOOKING = { days: [1, 2, 3, 4, 5], from: '09:00', to: '17:00', durations: [30, 60], notice: 2, ahead: 30 };
const STEP = 30;
const TIME = /^([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/;
const truthy = (value) => [1, '1', true, 'true'].includes(value);

/** `HH:mm` → minutes of the day, or null. */
export function minutesOf(value) {
  const m = String(value ?? '').trim().match(TIME);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
const clock = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/** Durations (minutes) of a `booking_durations` value ("30, 60"): 5 min to 8 h, no repeats. */
export function durationsOf(value) {
  const list = String(value ?? '').split(/[,;\s]+/).map((n) => (/^\d+$/.test(n) ? parseInt(n, 10) : NaN)).filter((n) => n >= 5 && n <= 480);
  return [...new Set(list)].sort((a, b) => a - b);
}

/** The booking rules of a Calendar row, with defaults for what it leaves empty. */
export function bookingConfig(calendar = {}) {
  const days = weekdaysOf(calendar.booking_days);
  const from = minutesOf(calendar.booking_from);
  const to = minutesOf(calendar.booking_to);
  const durations = durationsOf(calendar.booking_durations);
  const int = (value, fallback, min, max) => {
    const n = parseInt(value, 10);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  const valid = from !== null && to !== null && to > from;
  return {
    enabled: truthy(calendar.booking_enabled) && !truthy(calendar.disabled),
    days: days.length ? days : DEFAULT_BOOKING.days,
    from: valid ? clock(from) : DEFAULT_BOOKING.from,
    to: valid ? clock(to) : DEFAULT_BOOKING.to,
    durations: durations.length ? durations : DEFAULT_BOOKING.durations,
    notice: int(calendar.booking_notice_hours, DEFAULT_BOOKING.notice, 0, 720),
    ahead: int(calendar.booking_days_ahead, DEFAULT_BOOKING.ahead, 1, 365),
  };
}

/**
 * Busy ranges `[startMinute, endMinute)` of `day` out of the calendar's event
 * rows (their repetitions included). An all-day event takes the whole day.
 */
export function busyRanges(events, calendarFields, day) {
  const busy = [];
  for (const row of events) {
    const startDay = dayOf(row.starts_at);
    if (!startDay) continue;
    const endDay = dayOf(row.ends_at) || startDay;
    for (const first of occurrenceDays(row, calendarFields, day, day)) {
      const last = addDays(endDay, diffDays(first, startDay));
      if (first > day || last < day) continue;
      if (truthy(row.all_day)) { busy.push([0, 1440]); continue; }
      const from = first === day ? minutesOf(String(row.starts_at).slice(11, 16)) ?? 0 : 0;
      const to = last === day ? minutesOf(String(row.ends_at || '').slice(11, 16)) ?? from + 60 : 1440;
      if (to > from) busy.push([from, to]);
    }
  }
  return busy;
}

/**
 * Start times (`HH:mm`) free for a `duration`-minute booking on `day`.
 * `now` is the site's current wall clock; nothing starts before the notice.
 */
export function freeSlots({ day, duration, config, busy = [], now }) {
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  if (!config.enabled || !config.days.includes(weekday) || !config.durations.includes(duration)) return [];

  const today = now.slice(0, 10);
  if (day < today || day > addDays(today, config.ahead)) return [];
  // Minute of `day` before which the notice forbids booking (negative for later days).
  const earliest = (minutesOf(now.slice(11, 16)) ?? 0) + config.notice * 60 - diffDays(day, today) * 1440;

  const open = minutesOf(config.from);
  const close = minutesOf(config.to);
  const slots = [];
  for (let start = open; start + duration <= close; start += STEP) {
    if (start < earliest) continue;
    if (busy.some(([from, to]) => start < to && start + duration > from)) continue;
    slots.push(clock(start));
  }
  return slots;
}
