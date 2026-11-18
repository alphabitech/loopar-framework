import { test } from "node:test";
import assert from "node:assert/strict";
import { isImportableField, matchImportColumn, importValue } from "../../packages/loopar/core/global/list-import.js";

const field = (element, data = {}) => ({ element, data: { name: "f", label: "Field", ...data } });

test("isImportableField(): plain values a person may write", () => {
  assert.equal(isImportableField(field("input")), true);
  assert.equal(isImportableField(field("input", { name: "name", write_policy: "create_only" })), true);
  assert.equal(isImportableField(field("select")), true);
  assert.equal(isImportableField(field("input", { readonly: 1 })), false);
  assert.equal(isImportableField(field("input", { formula: "a + b" })), false);
  assert.equal(isImportableField(field("input", { hidden: 1 })), false);
  assert.equal(isImportableField(field("input", { write_policy: "protected" })), false);
  assert.equal(isImportableField(field("input", { write_policy: "system" })), false);
  assert.equal(isImportableField(field("password")), false);
  assert.equal(isImportableField(field("form_table")), false);
  assert.equal(isImportableField(field("file_input")), false);
});

test("matchImportColumn(): by name or label, ignoring case and spaces/underscores", () => {
  const fields = [{ name: "customer_name", label: "Customer" }, { name: "due_date", label: "Due date" }, { name: "total", label: "Total" }];
  assert.equal(matchImportColumn("customer_name", fields), "customer_name");
  assert.equal(matchImportColumn(" Customer Name ", fields), "customer_name");
  assert.equal(matchImportColumn("DUE DATE", fields), "due_date");
  assert.equal(matchImportColumn("customer", fields), "customer_name");
  assert.equal(matchImportColumn("Notes", fields), null);
  assert.equal(matchImportColumn("", fields), null);
});

test("importValue(): cells typed for their field", () => {
  assert.deepEqual(importValue("Yes", field("switch")), { value: 1 });
  assert.deepEqual(importValue("sí", field("switch")), { value: 1 });
  assert.deepEqual(importValue("", field("switch")), { value: 0 });
  assert.ok(importValue("maybe", field("switch")).issue);

  const money = field("input", { format: "currency" });
  assert.deepEqual(importValue("$1,234.50", money), { value: 1234.5 });
  assert.deepEqual(importValue("-12", money), { value: -12 });
  assert.deepEqual(importValue("1,234,567", money), { value: 1234567 });
  assert.ok(importValue("abc", money).issue);
  assert.ok(importValue("12abc34", money).issue);

  assert.deepEqual(importValue("2026-11-17 10:30", field("date")), { value: "2026-11-17" });
  assert.deepEqual(importValue("2026-11-17", field("date_time")), { value: "2026-11-17 00:00:00" });
  assert.deepEqual(importValue("2026-11-17T08:05", field("date_time")), { value: "2026-11-17 08:05:00" });
  assert.ok(importValue("11/17/2026", field("date")).issue);

  assert.deepEqual(importValue("  hello ", field("input")), { value: "hello" });
});

test("importValue(): a choice takes the option's value or its label", () => {
  const status = field("select", { options: "open:Open\npaid:Paid in full\nvoid" });
  assert.deepEqual(importValue("paid", status), { value: "paid" });
  assert.deepEqual(importValue("Paid in Full", status), { value: "paid" });
  assert.deepEqual(importValue("VOID", status), { value: "void" });
  assert.ok(importValue("refunded", status).issue);

  const tags = field("select", { options: "a:Alpha\nb:Beta", multiple: 1 });
  assert.deepEqual(importValue("Alpha, b", tags), { value: "[\"a\",\"b\"]" });
  assert.ok(importValue("Alpha, zeta", tags).issue);
});
