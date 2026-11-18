import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseReportSpec, formatReportSpec, emptyGroup, mergeGroup, groupValues, reportValueKey,
} from "../../packages/loopar/core/global/list-report.js";
import { bucketOf, nextBucket, bucketDays, dayOf } from "../../packages/loopar/core/global/date-buckets.js";
import { toCsv, csvCell, csvFileName } from "../../packages/loopar/core/global/csv.js";

test("parseReportSpec(): groups (with grain), values and chart from the query", () => {
  assert.equal(parseReportSpec({}), null);
  assert.equal(parseReportSpec({ report: " " }), null);
  assert.deepEqual(parseReportSpec({ report: "status,due_date.month", report_values: "sum.total,avg.total", report_chart: "line" }), {
    groups: [{ field: "status", grain: null }, { field: "due_date", grain: "month" }],
    values: [{ fn: "sum", field: "total" }, { fn: "avg", field: "total" }],
    chart: "line",
  });
  // No group: totals only.
  assert.deepEqual(parseReportSpec({ report: "-" }), { groups: [], values: [], chart: "bar" });
});

test("parseReportSpec(): only shapes pass — at most two groups, known functions, no repeats", () => {
  const spec = parseReportSpec({
    report: "a,a,b; drop table,c,d",
    report_values: "sum.total,sum.total,median.total,max.qty,sum.bad name",
    report_chart: "pie",
  });
  assert.deepEqual(spec.groups, [{ field: "a", grain: null }, { field: "c", grain: null }]);
  assert.deepEqual(spec.values, [{ fn: "sum", field: "total" }, { fn: "max", field: "qty" }]);
  assert.equal(spec.chart, "bar");
});

test("formatReportSpec(): the inverse, defaults left out", () => {
  const spec = { groups: [{ field: "status", grain: null }, { field: "due_date", grain: "week" }], values: [{ fn: "sum", field: "total" }], chart: "donut" };
  const query = formatReportSpec(spec);
  assert.deepEqual(query, { report: "status,due_date.week", report_values: "sum.total", report_chart: "donut" });
  assert.deepEqual(parseReportSpec(query), spec);
  assert.deepEqual(formatReportSpec({ groups: [], values: [], chart: "bar" }), { report: "-" });
});

test("mergeGroup(): partial groups add up exactly; the average comes from sum and count", () => {
  const values = [{ fn: "sum", field: "total" }, { fn: "avg", field: "total" }, { fn: "min", field: "total" }, { fn: "max", field: "total" }];
  const group = emptyGroup();
  // Database drivers hand decimals and counts as text.
  mergeGroup(group, { count: "2", fields: { total: { sum: "30.5", n: "2", min: "10", max: "20.5" } } });
  mergeGroup(group, { count: 3, fields: { total: { sum: 9, n: 1, min: 9, max: 9 } } });
  // Records without a value count as records, not as values.
  mergeGroup(group, { count: 1, fields: { total: { sum: null, n: 0, min: null, max: null } } });

  assert.equal(group.count, 6);
  assert.deepEqual(groupValues(group, values), { "sum.total": 39.5, "avg.total": 39.5 / 3, "min.total": 9, "max.total": 20.5 });
  assert.deepEqual(groupValues(emptyGroup(), values.slice(0, 1)), { "sum.total": null });
  assert.equal(reportValueKey(values[1]), "avg.total");
});

test("date buckets: keys, next bucket and the days a bucket covers", () => {
  assert.equal(bucketOf("2026-11-17", "day"), "2026-11-17");
  assert.equal(bucketOf("2026-11-17", "week"), "2026-11-16");
  assert.equal(bucketOf("2026-11-17", "month"), "2026-11");
  assert.equal(bucketOf("2026-11-17", "quarter"), "2026-Q4");
  assert.equal(bucketOf("2026-11-17", "year"), "2026");
  assert.equal(nextBucket("2026-Q4", "quarter"), "2027-Q1");
  assert.equal(nextBucket("2026-12", "month"), "2027-01");
  assert.deepEqual(bucketDays("2026-Q4", "quarter"), ["2026-10-01", "2026-12-31"]);
  assert.deepEqual(bucketDays("2028-02", "month"), ["2028-02-01", "2028-02-29"]);
  assert.deepEqual(bucketDays("2026-11-16", "week"), ["2026-11-16", "2026-11-22"]);
  assert.deepEqual(bucketDays("2026", "year"), ["2026-01-01", "2026-12-31"]);
  assert.equal(bucketDays("Open", "month"), null);
  assert.equal(dayOf("2026-11-17 10:20:00"), "2026-11-17");
  assert.equal(dayOf(""), null);
});

test("toCsv(): quoting, CRLF, BOM and formula text made inert", () => {
  assert.equal(toCsv([["Name", "Total"], ["A, \"B\"", 10.5], ["line\nbreak", null]], { bom: false }),
    "Name,Total\r\n\"A, \"\"B\"\"\",10.5\r\n\"line\nbreak\",\r\n");
  assert.ok(toCsv([["a"]]).startsWith("﻿"));
  assert.equal(csvCell("=SUM(A1:A9)"), "'=SUM(A1:A9)");
  assert.equal(csvCell("@cmd"), "'@cmd");
  assert.equal(csvCell("-12.50"), "-12.50");      // a number stays a number
  assert.equal(csvCell(-3), "-3");
  assert.equal(csvFileName("Sales Invoice", "2026-11-17"), "sales-invoice-2026-11-17.csv");
});

test("parseCsv(): the inverse of toCsv — quotes, line breaks, delimiters, BOM", async () => {
  const { parseCsv } = await import("../../packages/loopar/core/global/csv.js");
  const matrix = [["Name", "Notes", "Total"], ["A, \"B\"", "line\nbreak", "10.5"], ["", "x", ""]];
  assert.deepEqual(parseCsv(toCsv(matrix)), matrix);
  // Spreadsheets in many locales write semicolons; tabs come from a paste.
  assert.deepEqual(parseCsv("a;b;c\r\n1;\"x;y\";3\r\n"), [["a", "b", "c"], ["1", "x;y", "3"]]);
  assert.deepEqual(parseCsv("a\tb\n1\t2"), [["a", "b"], ["1", "2"]]);
  // Empty lines are dropped; a last line without a line end counts.
  assert.deepEqual(parseCsv("a,b\n\n,\n1,2"), [["a", "b"], ["1", "2"]]);
  assert.deepEqual(parseCsv(""), []);
});
