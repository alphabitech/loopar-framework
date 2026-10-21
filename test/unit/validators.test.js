import { test } from "node:test";
import assert from "node:assert/strict";
import { dataInterface } from "../../packages/loopar/core/global/element-definition.js";

const check = (element, data, value) => dataInterface({ element, data }, value).validate();
const input = (format, value, extra = {}) => check("input", { name: "amount", label: "Amount", format, ...extra }, value);

test("required: empty values fail, 0 and false are values", () => {
  assert.equal(check("input", { name: "name", required: 1 }, "").valid, false);
  assert.equal(check("input", { name: "name", required: 1 }, "  ").valid, false);
  assert.equal(check("input", { name: "name", required: 1 }, null).valid, false);
  assert.match(check("input", { name: "company_name", required: 1 }, "").message, /Company name is required/);
  assert.equal(check("input", { name: "qty", required: 1 }, 0).valid, true);
  assert.equal(check("switch", { name: "active", required: 1 }, false).valid, true);
});

test("an empty optional field skips its format check", () => {
  assert.equal(input("email", "").valid, true);
});

test("currency: zero, negatives and fractions are valid amounts", () => {
  for (const v of ["0", "-15", "0.75", "1200.50", 42]) assert.equal(input("currency", v).valid, true, String(v));
  for (const v of ["12a", "1.2.3", "$5"]) assert.equal(input("currency", v).valid, false, String(v));
});

test("int: whole numbers only (signed)", () => {
  for (const v of ["0", "42", "-3"]) assert.equal(input("int", v).valid, true, v);
  for (const v of ["1.5", "abc"]) assert.equal(input("int", v).valid, false, v);
});

test("float/decimal: any decimal number (signed)", () => {
  for (const f of ["float", "decimal", "double"]) {
    for (const v of ["1.5", "-0.25", "3"]) assert.equal(input(f, v).valid, true, `${f} ${v}`);
    assert.equal(input(f, "1,5").valid, false, `${f} 1,5`);
  }
});

test("email", () => {
  assert.equal(input("email", "contact@fabulouscleaning.boston").valid, true);
  const bad = input("email", "not-an-email");
  assert.equal(bad.valid, false);
  assert.match(bad.message, /Amount: Invalid email address/);
});

test("very long values are rejected before any regex runs", () => {
  assert.equal(input("email", "a".repeat(3000)).valid, false);
});

test("not_validate_type skips the format check", () => {
  assert.equal(input("email", "free text", { not_validate_type: 1 }).valid, true);
});
