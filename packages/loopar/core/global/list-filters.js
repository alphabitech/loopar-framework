'use strict';

import { resolveColumnFormat } from './element-definition.js';

/**
 * List filters with an operator — shared by the server (which turns them into
 * conditions) and the client (which writes them to the URL).
 *
 * A filter is a query parameter of the list. A bare field keeps the search
 * form's behavior (text contains, a choice matches); `field.op` picks the
 * operator:
 *
 *   ?status=Open                          search form: status is Open
 *   ?total.gte=1000                       total ≥ 1000
 *   ?due_date.between=2026-11-01..2026-11-30
 *   ?due_date.between=2026-11-01..        open range (from that day on)
 *   ?status.in=Open,Paid                  any of
 *   ?customer.empty=1                     has no customer
 *
 * A field name has no dot, so `field.op` never collides with a field.
 */
export const FILTER_OPS = Object.freeze([
  "eq", "ne", "gt", "gte", "lt", "lte", "between", "in", "nin", "like", "nlike", "empty", "filled",
]);

export const RANGE_SEPARATOR = "..";
const OPS = new Set(FILTER_OPS);
const MAX_IN_VALUES = 100;
const NUMERIC_FORMATS = new Set(["int", "long_int", "float", "double", "decimal", "currency", "percent"]);
const MOMENT = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/;

/** Record dates every audited entity keeps: filterable and groupable like date-time fields. */
export const SYSTEM_DATE_FIELDS = Object.freeze({
  __created_at__: "Created at",
  __updated_at__: "Updated at",
});

/** Operators offered per kind of field, first = the usual one. */
export const OPS_BY_KIND = Object.freeze({
  text: ["like", "eq", "ne", "nlike", "empty", "filled"],
  choice: ["eq", "ne", "in", "nin", "empty", "filled"],
  number: ["eq", "ne", "gt", "gte", "lt", "lte", "between", "empty", "filled"],
  date: ["eq", "gt", "gte", "lt", "lte", "between", "empty", "filled"],
  datetime: ["eq", "gt", "gte", "lt", "lte", "between", "empty", "filled"],
  bool: ["eq"],
});

/**
 * How a field (`{ element, data }`) filters and aggregates:
 * "text" | "choice" | "number" | "date" | "datetime" | "bool".
 */
export function filterKind(field) {
  const element = field?.element;
  if (element === "switch" || element === "checkbox") return "bool";
  if (element === "select" || element === "radio_group" || element === "connection") return "choice";
  if (element === "date") return "date";
  if (element === "date_time") return "datetime";
  if (element === "range" || element === "rating") return "number";
  if (NUMERIC_FORMATS.has(resolveColumnFormat(field))) return "number";
  return "text";
}

/** A number stored as a number: it can be summed. */
export const isNumericField = (field) => filterKind(field) === "number";

export const operatorsFor = (field) => OPS_BY_KIND[filterKind(field)];

/** `"total.gte"` → `{ field: "total", op: "gte" }`; a bare field has `op: null`. */
export function parseFilterKey(key) {
  const text = String(key ?? "");
  const at = text.lastIndexOf(".");
  if (at > 0 && OPS.has(text.slice(at + 1))) return { field: text.slice(0, at), op: text.slice(at + 1) };
  return { field: text, op: null };
}

export const filterKey = (field, op = null) => (op ? `${field}.${op}` : field);

const isDayOnly = (value) => value.length === 10;

function coerce(raw, kind) {
  const text = String(raw ?? "").trim();
  if (text === "") return undefined;
  if (kind === "number") {
    const n = Number(text);
    return Number.isFinite(n) ? n : undefined;
  }
  if (kind === "date") return MOMENT.test(text) ? text.slice(0, 10) : undefined;
  if (kind === "datetime") {
    if (!MOMENT.test(text)) return undefined;
    const moment = text.replace("T", " ");
    return moment.length === 16 ? `${moment}:00` : moment;
  }
  if (kind === "bool") return ["1", "true"].includes(text.toLowerCase()) ? 1 : 0;
  return text;
}

// A day compared against a date-time covers the whole day.
const dayStart = (value, kind) => (kind === "datetime" && isDayOnly(value) ? `${value} 00:00:00` : value);
const dayEnd = (value, kind) => (kind === "datetime" && isDayOnly(value) ? `${value} 23:59:59` : value);

/**
 * A filter as it applies: `{ field, op, value }` with its value typed for the
 * field's `kind`, or null when the operator doesn't fit the field or the
 * value is not valid (an unusable filter is dropped, never guessed).
 */
export function normalizeFilter({ field, op, value, kind = "text" }) {
  if (!field || !OPS.has(op) || !OPS_BY_KIND[kind]?.includes(op)) return null;
  const raw = String(value ?? "").trim();

  if (op === "empty" || op === "filled") {
    return ["", "0", "false"].includes(raw.toLowerCase()) ? null : { field, op, value: 1 };
  }

  if (op === "between") {
    const at = raw.indexOf(RANGE_SEPARATOR);
    if (at < 0) return null;
    const from = coerce(raw.slice(0, at), kind);
    const to = coerce(raw.slice(at + RANGE_SEPARATOR.length), kind);
    if (from === undefined && to === undefined) return null;
    if (to === undefined) return { field, op: "gte", value: dayStart(from, kind) };
    if (from === undefined) return { field, op: "lte", value: dayEnd(to, kind) };
    return { field, op, value: [dayStart(from, kind), dayEnd(to, kind)] };
  }

  if (op === "in" || op === "nin") {
    const values = raw.split(",").map((v) => coerce(v, kind)).filter((v) => v !== undefined).slice(0, MAX_IN_VALUES);
    return values.length ? { field, op, value: values } : null;
  }

  const typed = coerce(raw, kind);
  if (typed === undefined) return null;

  if (kind === "datetime" && isDayOnly(typed)) {
    if (op === "eq") return { field, op: "between", value: [dayStart(typed, kind), dayEnd(typed, kind)] };
    if (op === "gte" || op === "lt") return { field, op, value: dayStart(typed, kind) };
    if (op === "lte" || op === "gt") return { field, op, value: dayEnd(typed, kind) };
  }
  return { field, op, value: typed };
}

/**
 * Whether a record's value passes a normalized filter — for records that are
 * not in a table (virtual entities), with the meaning the SQL conditions have.
 */
export function matchFilter(actual, { op, value }, kind = "text") {
  const blank = actual === null || actual === undefined || actual === "";
  if (op === "empty") return blank;
  if (op === "filled") return !blank;

  const norm = (v) => {
    if (kind === "number") return Number(v);
    if (kind === "bool") return [1, "1", true, "true"].includes(v) ? 1 : 0;
    if (kind === "date") return String(v).slice(0, 10);
    if (kind === "datetime") return String(v).replace("T", " ").slice(0, 19);
    return String(v).toLowerCase();
  };
  const a = blank ? null : norm(actual);
  const same = (v) => a !== null && a === norm(v);

  switch (op) {
    case "eq": return same(value);
    case "ne": return !same(value);
    case "in": return value.some(same);
    case "nin": return !value.some(same);
    case "like": return a !== null && String(a).includes(norm(value));
    case "nlike": return a === null || !String(a).includes(norm(value));
    case "gt": return a !== null && a > norm(value);
    case "gte": return a !== null && a >= norm(value);
    case "lt": return a !== null && a < norm(value);
    case "lte": return a !== null && a <= norm(value);
    case "between": return a !== null && a >= norm(value[0]) && a <= norm(value[1]);
    default: return true;
  }
}
