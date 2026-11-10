import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { elementsDefinition, dataInterface, selectSource, selectEntity, multipleValues } from "../../packages/loopar/core/global/element-definition.js";
import { sanitizeAttributes, isAllowedAttribute } from "../../packages/loopar/core/global/custom-attributes.js";
import { evaluateCondition } from "../../packages/loopar/core/global/condition.js";

const COMPONENTS = path.resolve("packages/loopar/src/components");

test("every core element has its component file", () => {
  const missing = Object.values(elementsDefinition).flat()
    .filter((d) => !d.app)
    .map((d) => d.element)
    .filter((name) => !fs.existsSync(path.join(COMPONENTS, `${name.replaceAll("_", "-")}.jsx`)));
  assert.deepEqual(missing, []);
});

test("content schemas only use known text types", () => {
  const types = new Set(["line", "text", "lines", "rich"]);
  for (const def of Object.values(elementsDefinition).flat()) {
    for (const [prop, type] of Object.entries(def.content || {})) {
      assert.ok(types.has(type), `${def.element}.${prop}: ${type}`);
    }
  }
});

test("required_on makes a field required while its condition holds", () => {
  const field = { element: "input", data: { name: "phone", required_on: "contact = 'Phone'" } };
  assert.equal(dataInterface(field, "", { contact: "Phone" }).validate().valid, false);
  assert.equal(dataInterface(field, "", { contact: "Email" }).validate().valid, true);
  assert.equal(evaluateCondition("a = 1 and b", { a: 1, b: "x" }), true);
});

test("length, pattern and percent constraints", () => {
  const v = (data, value) => dataInterface({ element: "input", data: { name: "x", ...data } }, value).validate().valid;
  assert.equal(v({ min_length: 3 }, "ab"), false);
  assert.equal(v({ max_length: 3 }, "abcd"), false);
  assert.equal(v({ min_length: 2, max_length: 4 }, "abc"), true);
  assert.equal(v({ pattern: "[A-Z]{3}-\\d{2}" }, "ABC-12"), true);
  assert.equal(v({ pattern: "[A-Z]{3}-\\d{2}" }, "abc-12"), false);
  assert.equal(v({ format: "percent" }, "50.5"), true);
  assert.equal(v({ format: "percent" }, "150"), false);
  assert.equal(v({ min_length: 3 }, ""), true); // empty optional values are not checked
});

test("select sources: explicit wins, legacy one-line = entity", () => {
  assert.equal(selectSource({ options: "Customer" }), "entity");
  assert.equal(selectSource({ options: "Yes", options_source: "static" }), "static");
  assert.equal(selectSource({ options: "a\nb" }), "static");
  assert.equal(selectEntity({ options: "Customer", options_source: "entity" }), "Customer");
  assert.equal(selectEntity({ options: "a\nb" }), null);
  assert.deepEqual(multipleValues('["a","b"]'), ["a", "b"]);
  assert.deepEqual(multipleValues(""), []);
});

test("custom attributes: only safe names and values reach the DOM", () => {
  assert.deepEqual(sanitizeAttributes(JSON.stringify([
    { name: "data-track", value: "cta" },
    { name: "aria-label", value: "Open" },
    { name: "onclick", value: "alert(1)" },
    { name: "style", value: "color:red" },
    { name: "itemprop", value: "name" },
    { name: "data-href", value: "javascript:alert(1)" },
    { name: "Class", value: "x" },
  ])), { "data-track": "cta", "aria-label": "Open", itemprop: "name" });
  assert.equal(isAllowedAttribute("onmouseover"), false);
  assert.equal(isAllowedAttribute("role"), true);
});
