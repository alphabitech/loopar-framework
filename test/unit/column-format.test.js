import { test } from "node:test";
import assert from "node:assert/strict";
import "loopar";
import { resolveColumnFormat } from "../../packages/loopar/core/global/element-definition.js";

const field = (data) => ({ element: "input", data });

test("column format: format \"text\" is TEXT, not the `data` input-type alias", () => {
  assert.equal(resolveColumnFormat(field({ format: "text" })), "text");
  assert.equal(resolveColumnFormat(field({ format: "TEXT" })), "text");
  assert.equal(resolveColumnFormat(field({ format: "longtext" })), "longtext");
});

test("column format: type \"text\" keeps meaning a plain string (data)", () => {
  assert.equal(resolveColumnFormat(field({ type: "text" })), "data");
  assert.equal(resolveColumnFormat(field({ type: "VARCHAR" })), null);
});

test("column format: aliases still resolve through format", () => {
  assert.equal(resolveColumnFormat(field({ format: "integer" })), "int");
  assert.equal(resolveColumnFormat(field({ format: "read_only" })), "data");
  assert.equal(resolveColumnFormat(field({ format: "nope" })), null);
});
