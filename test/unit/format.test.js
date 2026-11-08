import { test } from "node:test";
import assert from "node:assert/strict";
import { formatNumber, formatCurrency, formatDate, formatDateTime, safeLocale } from "../../packages/loopar/core/global/format.js";

const en = { locale: "en-US", currency: "USD", timeZone: "America/New_York", dateFormat: "MM/DD/YYYY" };
const es = { locale: "es-ES", currency: "EUR", timeZone: "Europe/Madrid", dateFormat: "DD/MM/YYYY" };

test("numbers and money follow the locale", () => {
  assert.equal(formatNumber(1234.5, {}, en), "1,234.5");
  assert.equal(formatCurrency(10, null, {}, en), "$10.00");
  assert.match(formatCurrency(10, null, {}, es), /10,00\s?€/);
  assert.equal(formatCurrency(10, null, {}, { locale: "en" }), "10.00");
  assert.equal(formatNumber("", {}, en), "");
  assert.equal(formatNumber("abc", {}, en), "abc");
});

test("calendar dates never shift a day", () => {
  assert.equal(formatDate("2026-11-06", "short", en), "11/06/2026");
  assert.equal(formatDate("2026-11-06", "short", es), "06/11/2026");
  assert.equal(formatDate("2026-01-01", "medium", { ...en, timeZone: "Pacific/Honolulu" }), "Jan 1, 2026");
});

test("naive datetimes keep their wall time; zoned ones use the company zone", () => {
  assert.match(formatDateTime("2026-11-06 14:30:00", "short", en), /11\/06\/2026 0?2:30\s?PM/);
  assert.match(formatDateTime("2026-11-06T19:30:00Z", "short", en), /11\/06\/2026 0?2:30\s?PM/);
});

test("invalid locales fall back", () => {
  assert.equal(safeLocale("es-HN"), "es-HN");
  assert.equal(safeLocale("??"), "en");
});
