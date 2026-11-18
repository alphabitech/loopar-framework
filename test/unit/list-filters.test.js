import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseFilterKey, filterKey, filterKind, operatorsFor, normalizeFilter, matchFilter, isNumericField,
} from "../../packages/loopar/core/global/list-filters.js";

const field = (element, data = {}) => ({ element, data: { name: "f", ...data } });
const norm = (op, value, kind) => normalizeFilter({ field: "f", op, value, kind });

test("parseFilterKey(): `field.op` picks an operator, a bare field has none", () => {
  assert.deepEqual(parseFilterKey("total.gte"), { field: "total", op: "gte" });
  assert.deepEqual(parseFilterKey("__created_at__.between"), { field: "__created_at__", op: "between" });
  assert.deepEqual(parseFilterKey("status"), { field: "status", op: null });
  // Not an operator: the whole key is the (unknown) field.
  assert.deepEqual(parseFilterKey("total.drop"), { field: "total.drop", op: null });
  assert.equal(filterKey("total", "gte"), "total.gte");
  assert.equal(filterKey("status"), "status");
});

test("filterKind(): by element and column format", () => {
  assert.equal(filterKind(field("input")), "text");
  assert.equal(filterKind(field("input", { format: "currency" })), "number");
  assert.equal(filterKind(field("input", { format: "int" })), "number");
  assert.equal(filterKind(field("select")), "choice");
  assert.equal(filterKind(field("connection")), "choice");
  assert.equal(filterKind(field("date")), "date");
  assert.equal(filterKind(field("date_time")), "datetime");
  assert.equal(filterKind(field("switch")), "bool");
  assert.equal(isNumericField(field("textarea")), false);
  assert.ok(operatorsFor(field("date")).includes("between"));
  assert.ok(!operatorsFor(field("select")).includes("gt"));
});

test("normalizeFilter(): values are typed for the field; what doesn't fit is dropped", () => {
  assert.deepEqual(norm("gte", "1000", "number"), { field: "f", op: "gte", value: 1000 });
  assert.equal(norm("gte", "abc", "number"), null);
  assert.equal(norm("gt", "Open", "choice"), null);             // operator not for this kind
  assert.equal(norm("drop", "x", "text"), null);
  assert.deepEqual(norm("in", "Open, Paid,", "choice"), { field: "f", op: "in", value: ["Open", "Paid"] });
  assert.equal(norm("in", " , ", "choice"), null);
  assert.deepEqual(norm("empty", "1", "text"), { field: "f", op: "empty", value: 1 });
  assert.equal(norm("empty", "0", "text"), null);
  assert.equal(norm("eq", "2026-13-99x", "date"), null);
});

test("normalizeFilter(): ranges, open on either side", () => {
  assert.deepEqual(norm("between", "10..20", "number"), { field: "f", op: "between", value: [10, 20] });
  assert.deepEqual(norm("between", "10..", "number"), { field: "f", op: "gte", value: 10 });
  assert.deepEqual(norm("between", "..20", "number"), { field: "f", op: "lte", value: 20 });
  assert.equal(norm("between", "..", "number"), null);
  assert.equal(norm("between", "10", "number"), null);
  assert.deepEqual(norm("between", "2026-11-01..2026-11-30", "date"), { field: "f", op: "between", value: ["2026-11-01", "2026-11-30"] });
});

test("normalizeFilter(): a day against a date-time covers the whole day", () => {
  assert.deepEqual(norm("eq", "2026-11-17", "datetime"), { field: "f", op: "between", value: ["2026-11-17 00:00:00", "2026-11-17 23:59:59"] });
  assert.deepEqual(norm("between", "2026-11-01..2026-11-30", "datetime"), { field: "f", op: "between", value: ["2026-11-01 00:00:00", "2026-11-30 23:59:59"] });
  assert.deepEqual(norm("lte", "2026-11-17", "datetime"), { field: "f", op: "lte", value: "2026-11-17 23:59:59" });
  assert.deepEqual(norm("gt", "2026-11-17", "datetime"), { field: "f", op: "gt", value: "2026-11-17 23:59:59" });
  assert.deepEqual(norm("gte", "2026-11-17T08:30", "datetime"), { field: "f", op: "gte", value: "2026-11-17 08:30:00" });
});

test("matchFilter(): same meaning as the SQL conditions", () => {
  assert.equal(matchFilter("Open", norm("in", "open,Paid", "choice"), "choice"), true);
  assert.equal(matchFilter(null, norm("ne", "x", "text"), "text"), true);          // "is not" includes empty
  assert.equal(matchFilter(null, norm("gt", "1", "number"), "number"), false);
  assert.equal(matchFilter("5", norm("between", "1..10", "number"), "number"), true);
  assert.equal(matchFilter("2026-11-17 10:00:00", norm("eq", "2026-11-17", "datetime"), "datetime"), true);
  assert.equal(matchFilter("", norm("empty", "1", "text"), "text"), true);
  assert.equal(matchFilter("Boston", norm("like", "bos", "text"), "text"), true);
  assert.equal(matchFilter("Boston", norm("nlike", "bos", "text"), "text"), false);
});
