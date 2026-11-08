/**
 * Regional formatting shared by the server, the SSR render and the browser.
 *
 * Locale = the active language + the Company's country ("es-HN"); currency,
 * time zone and short date pattern come from the Company. The server
 * resolves them per request and the page receives the same values before
 * hydration (window.__LOOPAR_I18N__.regional), so SSR and client print the
 * same text — an implicit browser locale or time zone would not.
 *
 *   formatNumber(1234.5)          → "1,234.5" / "1.234,5"
 *   formatCurrency(10)            → "$10.00" / "L 10.00"
 *   formatDate("2026-11-06")      → "Nov 6, 2026" / "6 nov 2026"
 *   formatDateTime(isoString)     → in the Company's time zone
 */
import { currentLanguage } from "./i18n.js";

const PROVIDER_KEY = "__LOOPAR_I18N_PROVIDER__";
const CLIENT_KEY = "__LOOPAR_I18N__";

/** { locale, currency, timeZone, dateFormat } of the current request / page. */
export function regional() {
  const fromProvider = globalThis[PROVIDER_KEY]?.regional?.();
  const r = fromProvider || globalThis[CLIENT_KEY]?.regional || {};
  return { locale: r.locale || currentLanguage(), currency: r.currency || null, timeZone: r.timeZone || null, dateFormat: r.dateFormat || null };
}

/** A usable Intl locale ("es-HN"), falling back to the language, then "en". */
export function safeLocale(locale) {
  for (const candidate of [locale, String(locale || "").split("-")[0], "en"]) {
    try { if (candidate && Intl.getCanonicalLocales(candidate).length) return candidate; } catch { /* invalid */ }
  }
  return "en";
}

const toNumber = (v) => (typeof v === "number" ? v : Number(String(v ?? "").replace(/,/g, "")));

export function formatNumber(value, options = {}, r = regional()) {
  const n = toNumber(value);
  if (value === "" || value == null || !Number.isFinite(n)) return value == null ? "" : String(value);
  return new Intl.NumberFormat(safeLocale(r.locale), { maximumFractionDigits: 2, ...options }).format(n);
}

/** Money; without a currency (none set in Company) a plain 2-decimal number. */
export function formatCurrency(value, currency = null, options = {}, r = regional()) {
  const n = toNumber(value);
  if (value === "" || value == null || !Number.isFinite(n)) return value == null ? "" : String(value);
  const code = currency || r.currency;
  if (!code) return formatNumber(n, { minimumFractionDigits: 2, maximumFractionDigits: 2, ...options }, r);
  try {
    return new Intl.NumberFormat(safeLocale(r.locale), { style: "currency", currency: code, ...options }).format(n);
  } catch {
    return formatNumber(n, { minimumFractionDigits: 2, maximumFractionDigits: 2 }, r);
  }
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Date | ISO string | "YYYY-MM-DD" → { date, wall } (null when invalid).
 * `wall`: the value has no zone — a calendar date, or a naive stored
 * datetime ("2026-11-06 14:30:00"). It is read and printed in UTC so its
 * wall time never shifts, whatever the server's or browser's zone is.
 * Values with a zone (ISO with Z/offset, Date objects) print in the
 * Company's time zone.
 */
function toDate(value) {
  if (value == null || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : { date: value, wall: false, dateOnly: false };
  const s = String(value).trim();
  if (DATE_ONLY.test(s)) return { date: new Date(`${s}T00:00:00Z`), wall: true, dateOnly: true };
  const iso = s.includes(" ") && !s.includes("T") ? s.replace(" ", "T") : s;
  const zoned = /(Z|[+-]\d{2}:?\d{2})$/i.test(iso);
  const d = new Date(zoned ? iso : `${iso}Z`);
  return Number.isNaN(d.getTime()) ? null : { date: d, wall: !zoned, dateOnly: false };
}

const zoneOf = (parsed, r) => (parsed.wall ? "UTC" : r.timeZone || undefined);

const pad = (n) => String(n).padStart(2, "0");

/** Company short pattern (YYYY-MM-DD, DD/MM/YYYY, MM/DD/YYYY) applied to y/m/d. */
function applyPattern(pattern, y, m, d) {
  return pattern.replace("YYYY", String(y)).replace("MM", pad(m)).replace("DD", pad(d));
}

function partsIn(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(date);
  const get = (t) => Number(parts.find((p) => p.type === t)?.value);
  return { y: get("year"), m: get("month"), d: get("day") };
}

/**
 * @param value Date, ISO string or "YYYY-MM-DD"
 * @param style "short" (Company pattern), "medium", "long" or Intl options
 */
export function formatDate(value, style = "medium", r = regional()) {
  const parsed = toDate(value);
  if (!parsed) return value == null ? "" : String(value);
  const timeZone = zoneOf(parsed, r);
  if (style === "short" && r.dateFormat) {
    const { y, m, d } = partsIn(parsed.date, timeZone);
    return applyPattern(r.dateFormat, y, m, d);
  }
  const options = typeof style === "object" ? style
    : style === "long" ? { year: "numeric", month: "long", day: "numeric" }
    : style === "short" ? { year: "numeric", month: "2-digit", day: "2-digit" }
    : { year: "numeric", month: "short", day: "numeric" };
  return new Intl.DateTimeFormat(safeLocale(r.locale), { timeZone, ...options }).format(parsed.date);
}

export function formatTime(value, r = regional()) {
  const parsed = toDate(value);
  if (!parsed) return value == null ? "" : String(value);
  return new Intl.DateTimeFormat(safeLocale(r.locale), { timeZone: zoneOf(parsed, r), hour: "2-digit", minute: "2-digit" }).format(parsed.date);
}

export function formatDateTime(value, style = "medium", r = regional()) {
  const parsed = toDate(value);
  if (!parsed) return value == null ? "" : String(value);
  if (parsed.dateOnly) return formatDate(value, style, r);
  return `${formatDate(value, style, r)} ${formatTime(value, r)}`;
}

/** Country name in the active language ("HN" → "Honduras"). */
export function countryName(code, r = regional()) {
  if (!code) return "";
  try {
    return new Intl.DisplayNames([safeLocale(r.locale)], { type: "region" }).of(String(code).toUpperCase()) || String(code);
  } catch {
    return String(code);
  }
}
