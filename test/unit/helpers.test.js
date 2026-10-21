import { test } from "node:test";
import assert from "node:assert/strict";
import {
  args, trueValue, trueToBinary, JSONparse, Capitalize, avatar, decamelize, toEntityKey, kebabToPascal,
} from "../../packages/loopar/core/global/helper.js";

test("args(): positional arguments map onto the schema", () => {
  assert.deepEqual(args(["document", "name", "fields"], ["User", "admin", ["email"]]),
    { document: "User", name: "admin", fields: ["email"] });
});

test("args(): a single object with schema keys is taken as named arguments", () => {
  assert.deepEqual(args(["document", "name"], [{ document: "User", name: "admin" }]),
    { document: "User", name: "admin" });
});

test("args(): (first, options) when the object only holds options", () => {
  assert.deepEqual(args(["document", "name", "fields"], ["User", { ifNotFound: null, includeDeleted: true }]),
    { document: "User", ifNotFound: null, includeDeleted: true });
});

test("args(): (first, filter) keeps the filter as the second argument", () => {
  // getDoc("User", { email }) — the filter used to be read as options and dropped.
  assert.deepEqual(args(["document", "name", "fields"], ["User", { email: "a@b.c" }]),
    { document: "User", name: { email: "a@b.c" } });
});

test("args(): trailing options after every positional argument", () => {
  assert.deepEqual(args(["document", "field", "name"], ["User", "email", "admin", { ifNotFound: "x" }]),
    { document: "User", field: "email", name: "admin", ifNotFound: "x" });
});

test("trueValue()/trueToBinary() accept the framework's truthy spellings only", () => {
  for (const v of [true, "true", 1, "1"]) assert.equal(trueValue(v), true, String(v));
  for (const v of [false, "false", 0, "0", "", null, undefined, "yes"]) assert.equal(trueValue(v), false, String(v));
  assert.equal(trueToBinary("1"), 1);
  assert.equal(trueToBinary("no"), 0);
});

test("JSONparse() parses strings, passes parsed values through, falls back on bad input", () => {
  assert.deepEqual(JSONparse('{"a":1}'), { a: 1 });
  const arr = [{ a: 1 }];
  assert.equal(JSONparse(arr, []), arr);
  assert.deepEqual(JSONparse("{not json", []), []);
});

test("name helpers", () => {
  assert.equal(Capitalize("loopar"), "Loopar");
  assert.equal(avatar("Couple Hardwood Floors"), "CH");
  assert.equal(decamelize("PrintFormatBuilder"), "print-format-builder");
  assert.equal(kebabToPascal("print-format-builder"), "PrintFormatBuilder");
  assert.equal(toEntityKey("Print%20Format-Builder"), "printformatbuilder");
});
