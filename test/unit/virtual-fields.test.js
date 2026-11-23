import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isVirtualField, isComputedField, virtualFields, virtualFormulaIssue,
  virtualDependencies, applyVirtualFormulas, formulaFields,
} from "../../packages/loopar/core/global/formula.js";
import { compileFormula, computeFormulas, formulaRefs, refKey } from "../../packages/loopar/core/global/formula.js";
import { treeFields } from "../../packages/loopar/core/global/tree.js";
import { isImportableField } from "../../packages/loopar/core/global/list-import.js";

const input = (name, extra = {}) => ({ element: "input", data: { name, ...extra } });

test("isVirtualField / isComputedField: virtual and formula are independent flags", () => {
  assert.equal(isVirtualField({ virtual: 1 }), true);
  assert.equal(isVirtualField({ virtual: "true" }), true);
  assert.equal(isVirtualField({ virtual: 0 }), false);
  assert.equal(isVirtualField({ formula: "a + b" }), false);
  assert.equal(isComputedField({ formula: "a + b" }), true);
  assert.equal(isComputedField({ virtual: 1 }), true);
  assert.equal(isComputedField({ formula: "  " }), false);
  assert.equal(isComputedField({}), false);
});

test("virtualFields: nested, formula or null (filled by the model)", () => {
  const structure = [
    { element: "row", elements: [{ element: "col", elements: [
      input("balance", { virtual: 1 }),
      input("margin", { virtual: 1, formula: " price - cost " }),
      input("total", { formula: "qty * price" }),
      input("price"),
    ] }] },
  ];
  assert.deepEqual(virtualFields(structure), { balance: null, margin: "price - cost" });
  // formulaFields still lists every formula; the builder keeps only stored ones in __FORMULAS__.
  assert.deepEqual(Object.keys(formulaFields(structure)).sort(), ["margin", "total"]);
});

test("virtualFormulaIssue: own fields only, no child-table aggregates", () => {
  assert.equal(virtualFormulaIssue("price - cost"), null);
  assert.equal(virtualFormulaIssue("round(price * 1.15, 2)"), null);
  assert.match(virtualFormulaIssue("sum(lines.total)"), /child tables/);
  assert.ok(virtualFormulaIssue("price -"));
});

test("virtualDependencies: stored fields the formulas read", () => {
  assert.deepEqual(virtualDependencies({ balance: null, margin: "price - cost", pct: "margin / price" }).sort(), ["cost", "margin", "price"]);
});

test("applyVirtualFormulas: evaluated in place, in dependency order", () => {
  const rows = [{ price: 10, cost: 4 }, { price: "5", cost: "" }];
  applyVirtualFormulas({ balance: null, pct: "round(margin / price * 100, 1)", margin: "price - cost" }, rows);
  assert.deepEqual(rows, [
    { price: 10, cost: 4, margin: 6, pct: 60 },
    { price: "5", cost: "", margin: 5, pct: 100 },
  ]);
  assert.equal("balance" in rows[0], false, "model virtuals are left to virtualValues");
});

test("a virtual field is read-only everywhere computed fields are", () => {
  const parent = { element: "connection", data: { name: "parent_account", options: "Account", virtual: 1 } };
  assert.equal(treeFields([parent], "Account").editable, false);
  assert.equal(isImportableField(input("balance", { virtual: 1 })), false);
  assert.equal(isImportableField(input("price")), true);
});

/* ------------------------------------------------ references (link.field) */

test("link.field: parsed as a reference that reads its connection field", () => {
  const c = compileFormula("coalesce(app_name.description, '—')");
  assert.equal(c.error, undefined);
  assert.deepEqual(c.refs, [{ link: "app_name", field: "description" }]);
  assert.deepEqual(c.fields, ["app_name"]);
  assert.deepEqual(c.tables, []);
  // Aggregates keep their own table.field syntax.
  assert.deepEqual(compileFormula("sum(lines.total) * item.rate").refs, [{ link: "item", field: "rate" }]);
});

test("link.field: one level only, and a field name after the dot", () => {
  assert.match(compileFormula("app_name.company.name").error, /one level/);
  assert.ok(compileFormula("app_name.").error);
});

test("link.field: evaluated from the scope key the server fills", () => {
  const scope = { qty: 3, item: "BOLT", [refKey("item", "rate")]: "2.5" };
  assert.deepEqual(computeFormulas({ amount: "qty * item.rate" }, scope), { amount: 7.5 });
  assert.deepEqual(computeFormulas({ amount: "qty * item.rate" }, { qty: 3 }), { amount: 0 });
  assert.deepEqual(computeFormulas({ label: "coalesce(item.title, 'none')" }, {}), { label: "none" });
});

test("formulaRefs: what the formulas read, by connection", () => {
  assert.deepEqual(formulaRefs({ a: "item.rate * qty", b: "item.title", c: "app.description", d: null, e: "x +" }),
    { item: ["rate", "title"], app: ["description"] });
});

test("virtual formulas may read linked records; references never land on the row", () => {
  assert.equal(virtualFormulaIssue("app_name.description"), null);
  const rows = [{ app_name: "erp" }, { app_name: "crm" }];
  const linked = { erp: "Customers and billing", crm: null };
  applyVirtualFormulas({ app_description: "app_name.description" }, rows, (row) => ({ [refKey("app_name", "description")]: linked[row.app_name] }));
  assert.deepEqual(rows, [{ app_name: "erp", app_description: "Customers and billing" }, { app_name: "crm", app_description: null }]);
});
