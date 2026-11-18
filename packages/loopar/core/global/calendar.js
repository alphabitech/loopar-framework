'use strict';

/**
 * Calendar of an entity — shared by the server (which reads the range) and
 * the client (which draws it). An entity gets the view by convention, from
 * the names of its date fields; there is nothing to configure:
 *
 *   - a range: two `date` (or two `date_time`) fields named as a pair —
 *     `start_date`/`end_date`, `starts_at`/`ends_at`, `from_date`/`to_date`,
 *     `check_in_start`/`check_in_end`…
 *   - otherwise a single day: the first `date`/`date_time` field of the form.
 *
 * Hidden fields and the rows of child tables don't count. A switch named
 * `all_day` marks the records that take whole days (date_time entities).
 *
 * A select named `repeat` (Daily, Weekly, Monthly, Yearly; anything else =
 * once) makes the records recurring. Optional companions, by name:
 * `repeat_interval` (every N), `repeat_days` (weekdays of a weekly one, a
 * multiple select) and `repeat_until` (last day).
 *
 * A connection to User named `assigned_to` says who the record is for: the
 * calendar can then show each user only what is theirs.
 */

const DATE_ELEMENTS = new Set(["date", "date_time"]);
const RANGE_WORDS = [["start", "end"], ["starts", "ends"], ["begin", "end"], ["begins", "ends"], ["from", "to"]];
const truthy = (value) => [1, "1", true, "true"].includes(value);

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Name of the field that closes the range `name` opens, or null. */
function rangeEndName(name) {
  for (const [open, close] of RANGE_WORDS) {
    if (name === open) return close;
    if (name.startsWith(`${open}_`)) return close + name.slice(open.length);
    if (name.endsWith(`_${open}`)) return name.slice(0, -open.length) + close;
  }
  return null;
}

const readOnly = (el) => truthy(el.data.readonly) || truthy(el.data.read_only);

function allDayField(structure) {
  for (const el of structure || []) {
    if (el?.element === "form_table") continue;
    if (["switch", "checkbox"].includes(el?.element) && el.data?.name === "all_day") return el.data.name;
    const nested = el?.elements ? allDayField(el.elements) : null;
    if (nested) return nested;
  }
  return null;
}

/** The field named `name` (any of `elements`), outside child tables, or null. */
function namedField(structure, name, elements) {
  for (const el of structure || []) {
    if (el?.element === "form_table") continue;
    if (el?.data?.name === name && elements.includes(el.element)) return el;
    const nested = el?.elements ? namedField(el.elements, name, elements) : null;
    if (nested) return nested;
  }
  return null;
}

/** `{ freq, interval, days, until }` (field names, null when absent) or null. */
function repeatFields(structure) {
  if (!namedField(structure, "repeat", ["select", "radio_group"])) return null;
  const has = (name, elements) => (namedField(structure, name, elements) ? name : null);
  return {
    freq: "repeat",
    interval: has("repeat_interval", ["input", "range"]),
    days: has("repeat_days", ["select", "radio_group"]),
    until: has("repeat_until", ["date", "date_time"]),
  };
}

/** `assigned_to` when it is a connection to User (who the record is for), else null. */
function assigneeField(structure) {
  const field = namedField(structure, "assigned_to", ["connection"]);
  return field && String(field.data.options || "").trim() === "User" ? "assigned_to" : null;
}

function dateFields(structure, out = []) {
  for (const el of structure || []) {
    if (el?.element === "form_table") continue;
    if (DATE_ELEMENTS.has(el?.element) && el.data?.name && !truthy(el.data.hidden)) out.push(el);
    if (el?.elements) dateFields(el.elements, out);
  }
  return out;
}

/**
 * `{ start, end, time, allDay, repeat, assignee, editable }` for an entity structure,
 * or null when it has no date field. `end` is null for single-day entities;
 * `time` tells `date_time` fields; `allDay` names the all-day switch (or
 * null); `repeat` names the recurrence fields (or null); `assignee` names the
 * field with the users it is for (or null); `editable` is false when a field
 * is read-only.
 */
export function calendarFields(structure) {
  const parsed = typeof structure === "string" ? safeParse(structure) : structure;
  const structureList = Array.isArray(parsed) ? parsed : [];
  const fields = dateFields(structureList);
  if (!fields.length) return null;

  const describe = (start, end = null) => ({
    start: start.data.name,
    end: end ? end.data.name : null,
    time: start.element === "date_time",
    allDay: start.element === "date_time" ? allDayField(structureList) : null,
    repeat: repeatFields(structureList),
    assignee: assigneeField(structureList),
    editable: !readOnly(start) && !(end && readOnly(end)),
  });

  for (const start of fields) {
    const endName = rangeEndName(start.data.name);
    const end = endName && fields.find((f) => f.data.name === endName && f.element === start.element);
    if (end) return describe(start, end);
  }
  return describe(fields[0]);
}

function safeParse(text) {
  try { return JSON.parse(text); } catch { return []; }
}

const MS_DAY = 86400000;
const toUTC = (day) => Date.parse(`${day}T00:00:00Z`);
const fromUTC = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Whether `value` is a real calendar day (`YYYY-MM-DD`; no Feb 30). */
export const isDay = (value) => typeof value === "string" && DAY.test(value) && fromUTCSafe(value) === value;

function fromUTCSafe(day) {
  const ms = toUTC(day);
  return Number.isNaN(ms) ? null : fromUTC(ms);
}

/** Day (`YYYY-MM-DD`) of a stored date or date-time value, or null. */
export function dayOf(value) {
  if (value === null || value === undefined || value === "") return null;
  const day = String(value).slice(0, 10);
  return isDay(day) ? day : null;
}

/** `day` (`YYYY-MM-DD`) plus `n` days. */
export const addDays = (day, n) => fromUTC(toUTC(day) + n * MS_DAY);
/** Days from `b` to `a`. */
export const diffDays = (a, b) => Math.round((toUTC(a) - toUTC(b)) / MS_DAY);
/** 0 (Sunday) … 6 (Saturday). */
export const weekday = (day) => new Date(toUTC(day)).getUTCDay();

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const FREQUENCIES = ["daily", "weekly", "monthly", "yearly"];

/** Frequency of a record (`daily` | `weekly` | `monthly` | `yearly`) or null when it happens once. */
export function frequencyOf(row, calendar) {
  const freq = calendar?.repeat ? String(row?.[calendar.repeat.freq] ?? "").trim().toLowerCase() : "";
  return FREQUENCIES.includes(freq) ? freq : null;
}

/** Weekdays (0–6) of a `repeat_days` value: a JSON list, or names separated by commas. */
export function weekdaysOf(value) {
  let names = value;
  if (typeof value === "string") {
    try { names = JSON.parse(value); } catch { names = value.split(","); }
  }
  const list = (Array.isArray(names) ? names : [names]).map((n) => String(n ?? "").trim().toLowerCase()).filter(Boolean);
  return [...new Set(list.map((n) => WEEKDAYS.findIndex((w) => w === n || w.slice(0, 3) === n.slice(0, 3) && n.length <= 3)).filter((i) => i >= 0))].sort();
}

/**
 * A `repeat_days` value with every weekday moved `days` later (earlier when
 * negative), as the JSON list a multiple select stores: a weekly series on
 * Tuesdays and Thursdays moved one day later repeats on Wednesdays and Fridays.
 */
export function shiftWeekdays(value, days) {
  const title = (name) => name[0].toUpperCase() + name.slice(1);
  return JSON.stringify(weekdaysOf(value).map((d) => (((d + days) % 7) + 7) % 7).sort().map((d) => title(WEEKDAYS[d])));
}

/**
 * Start days of the occurrences of a record that touch `from`…`to` (days,
 * inclusive): its own start day when it happens once, one per repetition
 * when it recurs. Each occurrence lasts as many days as the record's own
 * range. At most `max` days.
 */
export function occurrenceDays(row, calendar, from, to, max = 400) {
  const first = dayOf(row?.[calendar.start]);
  if (!first) return [];
  const last = calendar.end ? dayOf(row[calendar.end]) : null;
  const span = last && last > first ? diffDays(last, first) : 0;
  const touches = (day) => day <= to && addDays(day, span) >= from;

  const freq = frequencyOf(row, calendar);
  if (!freq) return touches(first) ? [first] : [];

  const rec = calendar.repeat;
  const interval = Math.max(1, parseInt(rec.interval ? row[rec.interval] : 1, 10) || 1);
  const until = rec.until ? dayOf(row[rec.until]) : null;
  const limit = until && until < to ? until : to;
  const out = [];
  const push = (day) => { if (day >= first && day <= limit && touches(day) && out.length < max) out.push(day); };
  // Repetitions already over before the window are skipped by arithmetic, not by walking them.
  const lead = diffDays(from, first) - span;

  if (freq === "daily") {
    const skip = Math.max(0, Math.ceil(lead / interval));
    for (let day = addDays(first, skip * interval); day <= limit && out.length < max; day = addDays(day, interval)) push(day);
    return out;
  }

  if (freq === "weekly") {
    const chosen = rec.days ? weekdaysOf(row[rec.days]) : [];
    const days = chosen.length ? chosen : [weekday(first)];
    const week0 = addDays(first, -weekday(first));
    const step = 7 * interval;
    for (let w = Math.max(0, Math.floor((lead - 6) / step)); out.length < max; w++) {
      const base = addDays(week0, w * step);
      if (base > limit) break;
      for (const d of days) push(addDays(base, d));
    }
    return out;
  }

  const [y, m, d] = first.split("-").map(Number);
  const pad = (n) => String(n).padStart(2, "0");
  const monthsPerStep = freq === "monthly" ? interval : 12 * interval;
  const [fy, fm] = from.split("-").map(Number);
  const monthsAhead = (fy - y) * 12 + (fm - m);
  for (let n = Math.max(0, Math.floor(monthsAhead / monthsPerStep) - 1 - Math.ceil(span / 28 / monthsPerStep)); out.length < max; n++) {
    const total = m - 1 + n * monthsPerStep;
    const year = y + Math.floor(total / 12);
    const month = (total % 12) + 1;
    if (`${year}-${pad(month)}-01` > limit) break;
    // A month without that day (the 31st, Feb 29) has no occurrence.
    const day = `${year}-${pad(month)}-${pad(d)}`;
    if (isDay(day)) push(day);
  }
  return out;
}
