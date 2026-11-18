'use strict';

/**
 * Time buckets of a day (`YYYY-MM-DD`), shared by dashboards and list reports
 * (server and client). Bucketing is done in code, not in SQL: date functions
 * differ between SQLite, MySQL and Postgres.
 *
 *   day      2026-11-17
 *   week     2026-11-16      (its Monday)
 *   month    2026-11
 *   quarter  2026-Q4
 *   year     2026
 *
 * Bucket keys sort as text in time order.
 */
export const BUCKET_GRAINS = Object.freeze(["day", "week", "month", "quarter", "year"]);

const pad = (n) => String(n).padStart(2, "0");
const utc = (day) => new Date(`${day}T00:00:00Z`);

export const isoDay = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

/** 'YYYY-MM-DD' of a stored date/datetime (string or Date), or null. */
export function dayOf(value) {
  if (value == null || value === "") return null;
  if (value instanceof Date) return isNaN(value) ? null : isoDay(value);
  const s = String(value);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

/** `day` plus `n` days. */
export function shiftDay(day, n) {
  const d = utc(day);
  d.setUTCDate(d.getUTCDate() + n);
  return isoDay(d);
}

export function bucketOf(day, grain) {
  if (grain === "year") return day.slice(0, 4);
  if (grain === "quarter") return `${day.slice(0, 4)}-Q${Math.ceil(Number(day.slice(5, 7)) / 3)}`;
  if (grain === "month") return day.slice(0, 7);
  if (grain === "week") {
    const d = utc(day);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));   // Monday
    return isoDay(d);
  }
  return day;
}

export function nextBucket(bucket, grain) {
  if (grain === "year") return String(Number(bucket) + 1);
  if (grain === "quarter") {
    const [y, q] = bucket.split("-Q").map(Number);
    return q === 4 ? `${y + 1}-Q1` : `${y}-Q${q + 1}`;
  }
  if (grain === "month") {
    const [y, m] = bucket.split("-").map(Number);
    return m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`;
  }
  return shiftDay(bucket, grain === "week" ? 7 : 1);
}

/** First and last day of a bucket: `["2026-11-01", "2026-11-30"]`. Null when the key is not a bucket of `grain`. */
export function bucketDays(bucket, grain) {
  const key = String(bucket ?? "");
  const shape = {
    year: /^\d{4}$/, quarter: /^\d{4}-Q[1-4]$/, month: /^\d{4}-(0[1-9]|1[0-2])$/,
  }[grain] || /^\d{4}-\d{2}-\d{2}$/;
  if (!shape.test(key)) return null;

  if (grain === "year") return [`${key}-01-01`, `${key}-12-31`];
  if (grain === "quarter") {
    const firstOf = (quarter) => {
      const [y, q] = quarter.split("-Q").map(Number);
      return `${y}-${pad(q * 3 - 2)}-01`;
    };
    return [firstOf(key), shiftDay(firstOf(nextBucket(key, "quarter")), -1)];
  }
  if (grain === "month") return [`${key}-01`, shiftDay(`${nextBucket(key, "month")}-01`, -1)];
  if (grain === "week") return [key, shiftDay(key, 6)];
  return [key, key];
}
