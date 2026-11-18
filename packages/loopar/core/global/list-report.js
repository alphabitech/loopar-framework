'use strict';

import { BUCKET_GRAINS } from './date-buckets.js';

/**
 * Report view of a list: its records grouped by one or two fields, counted,
 * with numeric fields aggregated. The report is part of the list's URL, next
 * to its filters, so it can be shared:
 *
 *   /desk/Invoice/list?status=Open&report=customer,due_date.month&report_values=sum.total,avg.total&report_chart=bar
 *
 *   report          fields to group by, first to last; a date takes a grain
 *                   (`.day` `.week` `.month` `.quarter` `.year`). `-` groups by
 *                   nothing: one row with the totals.
 *   report_values   `fn.field` — sum | avg | min | max of a numeric field.
 *                   The record count is always there.
 *   report_chart    bar | line | area | donut | none
 */
export const REPORT_PARAM = "report";
export const REPORT_VALUES_PARAM = "report_values";
export const REPORT_CHART_PARAM = "report_chart";
export const REPORT_PARAMS = Object.freeze([REPORT_PARAM, REPORT_VALUES_PARAM, REPORT_CHART_PARAM]);

export const REPORT_FUNCTIONS = Object.freeze(["sum", "avg", "min", "max"]);
export const REPORT_CHARTS = Object.freeze(["bar", "line", "area", "donut", "none"]);
export const REPORT_NO_GROUP = "-";
export const MAX_REPORT_GROUPS = 2;
export const MAX_REPORT_VALUES = 6;
export const DEFAULT_GRAIN = "month";

const FIELD_NAME = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;

const last = (value) => String((Array.isArray(value) ? value[value.length - 1] : value) ?? "");

/** Key of an aggregated value in report rows: `"sum.total"`. */
export const reportValueKey = ({ fn, field }) => `${fn}.${field}`;

/**
 * Report of a query (`{ report, report_values, report_chart }`), or null when
 * it asks for none: `{ groups: [{ field, grain }], values: [{ fn, field }], chart }`.
 * Only shapes are checked here; the model decides which fields can group or add up.
 */
export function parseReportSpec(query = {}) {
  const raw = last(query?.[REPORT_PARAM]).trim();
  if (!raw) return null;

  const groups = [];
  if (raw !== REPORT_NO_GROUP) {
    for (const part of raw.split(",")) {
      const text = part.trim();
      const at = text.lastIndexOf(".");
      const grain = at > 0 && BUCKET_GRAINS.includes(text.slice(at + 1)) ? text.slice(at + 1) : null;
      const field = grain ? text.slice(0, at) : text;
      if (!FIELD_NAME.test(field) || groups.some((g) => g.field === field)) continue;
      groups.push({ field, grain });
      if (groups.length === MAX_REPORT_GROUPS) break;
    }
  }

  const values = [];
  for (const part of last(query?.[REPORT_VALUES_PARAM]).split(",")) {
    const [fn, ...rest] = part.trim().split(".");
    const field = rest.join(".");
    if (!REPORT_FUNCTIONS.includes(fn) || !FIELD_NAME.test(field)) continue;
    if (values.some((v) => v.fn === fn && v.field === field)) continue;
    values.push({ fn, field });
    if (values.length === MAX_REPORT_VALUES) break;
  }

  const chart = last(query?.[REPORT_CHART_PARAM]).trim();
  return { groups, values, chart: REPORT_CHARTS.includes(chart) ? chart : "bar" };
}

/** The inverse of parseReportSpec: the report's query parameters (empty ones left out). */
export function formatReportSpec({ groups = [], values = [], chart = "bar" } = {}) {
  const out = {
    [REPORT_PARAM]: groups.length
      ? groups.map((g) => (g.grain ? `${g.field}.${g.grain}` : g.field)).join(",")
      : REPORT_NO_GROUP,
  };
  if (values.length) out[REPORT_VALUES_PARAM] = values.map(reportValueKey).join(",");
  if (chart && chart !== "bar") out[REPORT_CHART_PARAM] = chart;
  return out;
}

/** Empty accumulator of one group: the record count and, per numeric field, what every function needs. */
export const emptyGroup = () => ({ count: 0, fields: {} });

/**
 * Adds a partial result into a group. `partial`: `{ count, fields: { total:
 * { sum, n, min, max } } }` — one SQL group, or one record. Sum, count, min
 * and max merge exactly; the average is derived at the end (sum / n).
 */
export function mergeGroup(into, partial) {
  into.count += Number(partial.count) || 0;
  for (const [field, part] of Object.entries(partial.fields || {})) {
    const n = Number(part.n) || 0;
    if (!n) continue;
    const acc = (into.fields[field] ??= { sum: 0, n: 0, min: null, max: null });
    acc.sum += Number(part.sum) || 0;
    acc.n += n;
    const lo = Number(part.min), hi = Number(part.max);
    if (Number.isFinite(lo)) acc.min = acc.min === null ? lo : Math.min(acc.min, lo);
    if (Number.isFinite(hi)) acc.max = acc.max === null ? hi : Math.max(acc.max, hi);
  }
  return into;
}

/** `{ "sum.total": 1200, "avg.total": 300 }` of a group; null where no record has a value. */
export function groupValues(group, values = []) {
  const out = {};
  for (const value of values) {
    const acc = group.fields[value.field];
    out[reportValueKey(value)] = !acc || !acc.n ? null
      : value.fn === "sum" ? acc.sum
      : value.fn === "avg" ? acc.sum / acc.n
      : value.fn === "min" ? acc.min
      : acc.max;
  }
  return out;
}
