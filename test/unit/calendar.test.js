import { test } from "node:test";
import assert from "node:assert/strict";
import { calendarFields, dayOf, isDay, addDays, occurrenceDays, frequencyOf, shiftWeekdays } from "../../packages/loopar/core/global/calendar.js";

const field = (name, element = "date", data = {}) => ({ element, data: { name, ...data } });
const wrap = (...elements) => [{ element: "row", elements: [{ element: "col", elements }] }];

test("calendarFields(): a named pair is a range, wherever it sits in the form", () => {
  const structure = wrap(field("title", "input"), field("due_date"), field("start_date"), field("end_date"));
  assert.deepEqual(calendarFields(structure), { start: "start_date", end: "end_date", time: false, allDay: null, repeat: null, assignee: null, editable: true });
  assert.deepEqual(calendarFields(JSON.stringify(wrap(field("starts_at", "date_time"), field("ends_at", "date_time")))),
    { start: "starts_at", end: "ends_at", time: true, allDay: null, repeat: null, assignee: null, editable: true });
  assert.equal(calendarFields(wrap(field("shift_start"), field("shift_end"))).end, "shift_end");
  assert.equal(calendarFields(wrap(field("from_date"), field("to_date"))).end, "to_date");
});

test("calendarFields(): without a pair, the first date field is a single day", () => {
  assert.deepEqual(calendarFields(wrap(field("date"), field("valid_until"))), { start: "date", end: null, time: false, allDay: null, repeat: null, assignee: null, editable: true });
  // A pair needs both ends of the same kind.
  assert.equal(calendarFields(wrap(field("start_date"), field("end_date", "date_time"))).end, null);
  assert.equal(calendarFields(wrap(field("start_date", "date", { readonly: 1 }))).editable, false);
  assert.equal(calendarFields(wrap(field("start_date", "date", { read_only: 1 }))).editable, false);
  assert.equal(calendarFields(wrap(field("starts_at", "date_time"), field("all_day", "switch"))).allDay, "all_day");
  assert.equal(calendarFields(wrap(field("date"), field("all_day", "switch"))).allDay, null);
});

test("calendarFields(): no date field, hidden ones and child rows give no calendar", () => {
  assert.equal(calendarFields(wrap(field("title", "input"))), null);
  assert.equal(calendarFields(wrap(field("sent_at", "date_time", { hidden: 1 }))), null);
  assert.equal(calendarFields([{ element: "form_table", data: { name: "items" }, elements: [field("date")] }]), null);
  assert.equal(calendarFields("not json"), null);
});

test("dayOf()/isDay()/addDays(): days out of stored values", () => {
  assert.equal(dayOf("2026-11-17 08:30:00"), "2026-11-17");
  assert.equal(dayOf(""), null);
  assert.equal(dayOf("0000-00-00"), null);
  assert.equal(isDay("2026-13-01"), false);
  assert.equal(addDays("2026-11-30", 1), "2026-12-01");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
});

const REPEAT = { start: "starts_at", end: "ends_at", time: true, repeat: { freq: "repeat", interval: "repeat_interval", days: "repeat_days", until: "repeat_until" } };

test("calendarFields(): a select named `repeat` makes the entity recurring", () => {
  const structure = wrap(field("starts_at", "date_time"), field("ends_at", "date_time"), field("repeat", "select"), field("repeat_days", "select"), field("repeat_until", "date"));
  assert.deepEqual(calendarFields(structure).repeat, { freq: "repeat", interval: null, days: "repeat_days", until: "repeat_until" });
  assert.equal(calendarFields(wrap(field("date"), field("repeat", "input"))).repeat, null);
});

test("occurrenceDays(): once, daily and the until limit", () => {
  const once = { starts_at: "2026-11-17 09:00:00", ends_at: "2026-11-17 10:00:00", repeat: "None" };
  assert.equal(frequencyOf(once, REPEAT), null);
  assert.deepEqual(occurrenceDays(once, REPEAT, "2026-11-01", "2026-11-30"), ["2026-11-17"]);
  assert.deepEqual(occurrenceDays(once, REPEAT, "2026-12-01", "2026-12-31"), []);

  const daily = { ...once, repeat: "Daily", repeat_interval: 2, repeat_until: "2026-11-22" };
  assert.deepEqual(occurrenceDays(daily, REPEAT, "2026-11-01", "2026-11-30"), ["2026-11-17", "2026-11-19", "2026-11-21"]);
  // A far window starts on the right phase without walking from the first day.
  const forever = { ...once, repeat: "Daily", repeat_interval: 3 };
  assert.deepEqual(occurrenceDays(forever, REPEAT, "2030-01-01", "2030-01-07"), ["2030-01-03", "2030-01-06"]);
});

test("occurrenceDays(): weekly on chosen days, every N weeks", () => {
  const row = { starts_at: "2026-11-17 18:00:00", ends_at: "2026-11-17 19:00:00", repeat: "Weekly", repeat_days: '["Monday","Wednesday"]' };
  // Starts on a Tuesday: the Monday of that week is before the start.
  assert.deepEqual(occurrenceDays(row, REPEAT, "2026-11-15", "2026-11-28"), ["2026-11-18", "2026-11-23", "2026-11-25"]);
  const own = { ...row, repeat_days: "", repeat_interval: 2 };
  assert.deepEqual(occurrenceDays(own, REPEAT, "2026-11-01", "2026-12-31"), ["2026-11-17", "2026-12-01", "2026-12-15", "2026-12-29"]);
});

test("occurrenceDays(): monthly and yearly skip the months without that day", () => {
  const monthly = { starts_at: "2026-01-31 08:00:00", ends_at: null, repeat: "Monthly" };
  assert.deepEqual(occurrenceDays(monthly, REPEAT, "2026-01-01", "2026-05-31"), ["2026-01-31", "2026-03-31", "2026-05-31"]);
  const yearly = { starts_at: "2024-02-29 08:00:00", ends_at: null, repeat: "Yearly" };
  assert.deepEqual(occurrenceDays(yearly, REPEAT, "2025-01-01", "2028-12-31"), ["2028-02-29"]);
});

test("occurrenceDays(): a multi-day occurrence that started before the window still shows", () => {
  const cal = { start: "start_date", end: "end_date", time: false, repeat: { freq: "repeat", interval: null, days: null, until: null } };
  const row = { start_date: "2026-11-02", end_date: "2026-11-04", repeat: "Weekly" };
  assert.deepEqual(occurrenceDays(row, cal, "2026-11-11", "2026-11-17"), ["2026-11-09", "2026-11-16"]);
});

test("shiftWeekdays(): the chosen days follow a moved weekly series", () => {
  assert.equal(shiftWeekdays('["Tuesday","Thursday"]', 1), '["Wednesday","Friday"]');
  assert.equal(shiftWeekdays('["Saturday","Monday"]', 1), '["Sunday","Tuesday"]');
  assert.equal(shiftWeekdays("Monday", -2), '["Saturday"]');
  assert.equal(shiftWeekdays("", 3), "[]");
});

test("calendarFields(): `assigned_to` counts only as a connection to User", () => {
  const to = (options) => wrap(field("date"), field("assigned_to", "connection", { options }));
  assert.equal(calendarFields(to("User")).assignee, "assigned_to");
  assert.equal(calendarFields(to("Customer")).assignee, null);
});

test("buildICal(): timed, all-day and recurring events", async () => {
  const { buildICal } = await import("../../apps/loopar/modules/calendar/ical.js");
  const text = buildICal({
    name: "General",
    host: "example.com",
    timeZone: "America/New_York",
    now: new Date("2026-11-17T12:00:00Z"),
    toInstant: (local) => new Date(`${local.replace(" ", "T")}-05:00`),
    events: [
      { name: "EVT-1", title: "Visit; site, A", starts_at: "2026-11-25 15:30:00", ends_at: "2026-11-25 16:30:00", all_day: 0, location: "591 Summer St", description: "Line 1\nLine 2" },
      { name: "EVT-2", title: "Fair", starts_at: "2026-12-01 00:00:00", ends_at: "2026-12-02 00:00:00", all_day: 1 },
      { name: "EVT-3", title: "Class", starts_at: "2026-11-03 18:00:00", ends_at: "2026-11-03 19:00:00", all_day: 0, repeat: "Weekly", repeat_interval: 2, repeat_days: '["Tuesday","Thursday"]', repeat_until: "2026-12-31" },
      { name: "EVT-4", title: "No start", starts_at: null },
    ],
  });
  const lines = text.split("\r\n");
  assert.equal(lines[0], "BEGIN:VCALENDAR");
  assert.equal(lines.at(-2), "END:VCALENDAR");
  assert.equal(lines.filter((l) => l === "BEGIN:VEVENT").length, 3);
  assert.ok(lines.includes("UID:EVT-1@example.com"));
  assert.ok(lines.includes("DTSTART;TZID=America/New_York:20261125T153000"));
  assert.ok(lines.includes("DTEND;TZID=America/New_York:20261125T163000"));
  assert.ok(lines.includes("SUMMARY:Visit\\; site\\, A"));
  assert.ok(lines.includes("DESCRIPTION:Line 1\\nLine 2"));
  assert.ok(lines.includes("DTSTART;VALUE=DATE:20261201"));
  assert.ok(lines.includes("DTEND;VALUE=DATE:20261203"));
  assert.ok(lines.includes("RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;UNTIL=20270101T045959Z"));
  assert.ok(lines.every((l) => l.length <= 75));
});

test("booking: free slots respect hours, events, notice and the open days", async () => {
  const { bookingConfig, busyRanges, freeSlots, durationsOf, minutesOf } = await import("../../apps/loopar/modules/calendar/booking.js");
  assert.deepEqual(durationsOf("60, 30; 30 x 2000"), [30, 60]);
  assert.equal(minutesOf("9:30"), 570);
  assert.equal(minutesOf("25:00"), null);

  const config = bookingConfig({ booking_enabled: 1, booking_from: "09:00", booking_to: "12:00", booking_durations: "30,60", booking_notice_hours: 2, booking_days: '["Monday","Tuesday"]' });
  assert.deepEqual(config.days, [1, 2]);
  assert.equal(bookingConfig({ booking_enabled: 1, disabled: 1 }).enabled, false);

  const fields = { start: "starts_at", end: "ends_at", time: true, repeat: { freq: "repeat", interval: "repeat_interval", days: "repeat_days", until: "repeat_until" } };
  const events = [
    { starts_at: "2026-11-17 10:00:00", ends_at: "2026-11-17 11:00:00", all_day: 0, repeat: "None" },
    { starts_at: "2026-11-10 11:30:00", ends_at: "2026-11-10 12:00:00", all_day: 0, repeat: "Weekly" }, // every Tuesday
  ];
  const day = "2026-11-17"; // a Tuesday
  const busy = busyRanges(events, fields, day);
  assert.deepEqual(busy, [[600, 660], [690, 720]]);

  const now = "2026-11-16 08:00:00";
  assert.deepEqual(freeSlots({ day, duration: 30, config, busy, now }), ["09:00", "09:30", "11:00"]);
  assert.deepEqual(freeSlots({ day, duration: 60, config, busy, now }), ["09:00"]);
  // Notice: at 08:00 of the same day nothing before 10:00.
  assert.deepEqual(freeSlots({ day, duration: 30, config, busy, now: "2026-11-17 08:00:00" }), ["11:00"]);
  // Closed day, unknown duration, past day, all-day event.
  assert.deepEqual(freeSlots({ day: "2026-11-18", duration: 30, config, busy: [], now }), []);
  assert.deepEqual(freeSlots({ day, duration: 45, config, busy, now }), []);
  assert.deepEqual(freeSlots({ day: "2026-11-10", duration: 30, config, busy: [], now }), []);
  assert.deepEqual(freeSlots({ day, duration: 30, config, busy: busyRanges([{ starts_at: "2026-11-17 00:00:00", ends_at: "2026-11-17 00:00:00", all_day: 1 }], fields, day), now }), []);
});
