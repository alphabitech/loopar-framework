import { test } from "node:test";
import assert from "node:assert/strict";
import { inferParentFilter, findFieldMeta, parseFilters } from "../../packages/loopar/core/global/parent-filter.js";

const refs = {
  Address: { __FIELD_META__: {
    state: { element: "connection", options: "State" },
    lines: { element: "form_table", options: "Address Line" },
  } },
  "Address Line": { __FIELD_META__: { region: { element: "connection", options: "State" } } },
  City: { __FIELD_META__: {
    province: { element: "connection", options: "State" },
    country: { element: "select" },
  } },
  Twins: { __FIELD_META__: {
    a: { element: "connection", options: "State" },
    b: { element: "connection", options: "State" },
    state: { element: "input" },
  } },
  "Entity Directory": { is_virtual: 1, __FIELD_META__: {} },
};
const getRef = (n) => refs[n] || null;

test("parent_filter given wins", () => {
  assert.equal(inferParentFilter({ target: "City", source: "Address", parent: "state", parentFilter: "country" }, getRef), "country");
});

test("infers the one field connecting to the parent's entity", () => {
  assert.equal(inferParentFilter({ target: "City", source: "Address", parent: "state" }, getRef), "province");
});

test("parent inside a child table counts", () => {
  assert.equal(findFieldMeta("Address", "region", getRef)?.options, "State");
  assert.equal(inferParentFilter({ target: "City", source: "Address", parent: "region" }, getRef), "province");
});

test("ambiguous matches fall back to the field named like the parent", () => {
  assert.equal(inferParentFilter({ target: "Twins", source: "Address", parent: "state" }, getRef), "state");
});

test("nothing fits → no filter; a virtual target keeps the parent name", () => {
  assert.equal(inferParentFilter({ target: "City", source: "Address", parent: "lines" }, getRef), null);
  assert.equal(inferParentFilter({ target: "Entity Directory", source: "Entity", parent: "options" }, getRef), "options");
});

test("parseFilters reads lines and JSON", () => {
  assert.deepEqual(parseFilters("mode = fields\nkinds: scalar"), { mode: "fields", kinds: "scalar" });
  assert.deepEqual(parseFilters('{"status":"Active"}'), { status: "Active" });
  assert.deepEqual(parseFilters("garbage"), {});
  assert.deepEqual(parseFilters(null), {});
});
