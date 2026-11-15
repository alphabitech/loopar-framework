import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isListableField, parseSort, formatSort, normalizeListSettings, resolveListColumns, listColumnChoices, TITLE_COLUMN,
} from "../../packages/loopar/core/global/list-settings.js";

const field = (name, data = {}, element = "input") => ({ element, data: { name, ...data } });
const names = (cols) => cols.map((c) => c.data.name);

const FIELDS = [
  field("name", { in_list_view: 1 }),
  field("customer", { in_list_view: 1 }, "connection"),
  field("plan", { in_list_view: 1 }),
  field("tenant_name", { in_list_view: 1, list_order: 1 }),
  field("notes", {}, "textarea"),
  field("token", { hidden: 1 }),
  field("secret", {}, "password"),
  field("items", {}, "form_table"),
];

test("parseSort()/formatSort(): round trip, duplicates and junk dropped", () => {
  assert.deepEqual(parseSort("plan,-status"), [{ field: "plan", dir: "asc" }, { field: "status", dir: "desc" }]);
  assert.equal(formatSort(parseSort("plan,-status,plan, ,x y")), "plan,-status");
  assert.equal(parseSort("a,b,c,d,e,f,g").length, 5);
  assert.deepEqual(parseSort(null), []);
});

test("isListableField(): plain values only, never hidden fields or secrets", () => {
  assert.equal(isListableField(field("notes", {}, "textarea")), true);
  assert.equal(isListableField(field("token", { hidden: 1 })), false);
  assert.equal(isListableField(field("secret", {}, "password")), false);
  assert.equal(isListableField(field("pin", { type: "password" })), false);
  assert.equal(isListableField(field("otp", { write_policy: "system" })), false);
  assert.equal(isListableField(field("items", {}, "form_table")), false);
});

test("normalizeListSettings(): keeps only checked values", () => {
  const s = normalizeListSettings(JSON.stringify({
    order: ["plan", "plan", "bad name", 3], hidden: "x", shown: ["notes"],
    widths: { plan: 10, [TITLE_COLUMN]: 300.4, "bad name": 100, notes: "wide" },
    sort: [{ field: "plan", dir: "desc" }, { field: "1x" }, null], extra: true,
  }));
  assert.deepEqual(s, {
    order: ["plan"], hidden: [], shown: ["notes"],
    widths: { plan: 60, [TITLE_COLUMN]: 300 },
    sort: [{ field: "plan", dir: "desc" }],
  });
  assert.deepEqual(normalizeListSettings("not json"), { order: [], hidden: [], shown: [], widths: {}, sort: [] });
});

test("resolveListColumns(): list_order first by default; the user's order, hidden and shown win", () => {
  assert.deepEqual(names(resolveListColumns(FIELDS)), ["tenant_name", "name", "customer", "plan"]);
  assert.deepEqual(
    names(resolveListColumns(FIELDS, { order: ["plan", "notes"], hidden: ["name"], shown: ["notes", "token", "secret", "items"] })),
    ["plan", "notes", "tenant_name", "customer"]
  );
});

test("listColumnChoices(): the list columns, then every other listable field", () => {
  const choices = listColumnChoices(FIELDS);
  assert.deepEqual(names(choices.map((c) => c.field)), ["name", "customer", "plan", "tenant_name", "notes"]);
  assert.deepEqual(choices.map((c) => c.isDefault), [true, true, true, true, false]);
});
