import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WRITE_POLICY, fieldPolicy, fieldRoles, writePolicyMap, canWriteFromInput,
  filterInput, guardedChanges, renderLock, comparable,
} from "../../packages/loopar/core/global/field-policy.js";

const structure = [
  { element: "tabs", data: {}, elements: [
    { element: "input", data: { name: "first_name" } },
    { element: "input", data: { name: "name", set_only_time: 1 } },
    { element: "input", data: { name: "email", write_policy: "protected" } },
    { element: "password", data: { name: "password", write_policy: "protected" } },
    { element: "select", data: { name: "user_type", write_roles: "System Manager, HR" } },
    { element: "switch", data: { name: "mfa_enabled", write_policy: "system" } },
    { element: "input", data: { name: "total", write_policy: "readonly" } },
    { element: "input", data: { name: "notes", readonly: 1 } },
  ] },
];
const map = writePolicyMap(structure);
const user = { isAdmin: false, roles: [] };

test("fieldPolicy: default editable, set_only_time → create_only, unknown → editable", () => {
  assert.equal(fieldPolicy({}), WRITE_POLICY.EDITABLE);
  assert.equal(fieldPolicy({ set_only_time: 1 }), WRITE_POLICY.CREATE_ONLY);
  assert.equal(fieldPolicy({ write_policy: "SYSTEM" }), WRITE_POLICY.SYSTEM);
  assert.equal(fieldPolicy({ write_policy: "whatever" }), WRITE_POLICY.EDITABLE);
});

test("fieldRoles: comma or newline separated, trimmed, unique", () => {
  assert.deepEqual(fieldRoles({ write_roles: " A, B\nA ,," }), ["A", "B"]);
  assert.deepEqual(fieldRoles({}), []);
});

test("writePolicyMap: only restricted fields, nested, with legacy readonly", () => {
  assert.deepEqual(Object.keys(map).sort(),
    ["email", "mfa_enabled", "name", "notes", "password", "total", "user_type"]);
  assert.equal(map.first_name, undefined);
  assert.equal(map.notes.policy, WRITE_POLICY.EDITABLE);
  assert.equal(map.notes.legacyReadonly, true);
});

test("filterInput update: drops system/readonly/protected/create_only/role fields", () => {
  const input = {
    first_name: "Ana", name: "renamed", email: "evil@x.com", password: "P@ss1234",
    user_type: "System", mfa_enabled: 0, total: 0, notes: "ok", unknown: 1,
  };
  const { data, dropped } = filterInput(map, input, { op: "update", actor: user });
  assert.deepEqual(data, { first_name: "Ana", password: "********", notes: "ok", unknown: 1 });
  assert.deepEqual(dropped.map((d) => `${d.field}:${d.reason}`).sort(), [
    "email:protected", "mfa_enabled:system", "name:create_only",
    "password:protected", "total:readonly", "user_type:roles",
  ]);
});

test("filterInput create: protected and create_only are allowed, system/readonly never", () => {
  const { data } = filterInput(map, { name: "u1", email: "a@b.c", mfa_enabled: 1, total: 9 },
    { op: "create", actor: user });
  assert.deepEqual(data, { name: "u1", email: "a@b.c" });
});

test("filterInput: roles allow the field; Administrator always passes roles", () => {
  const hr = filterInput(map, { user_type: "Web" }, { op: "update", actor: { roles: ["HR"] } });
  assert.deepEqual(hr.data, { user_type: "Web" });
  const admin = filterInput(map, { user_type: "Web" }, { op: "update", actor: { isAdmin: true } });
  assert.deepEqual(admin.data, { user_type: "Web" });
  // ...but roles never lift system/readonly.
  const sys = filterInput(map, { mfa_enabled: 0 }, { op: "update", actor: { isAdmin: true } });
  assert.deepEqual(sys.data, {});
});

test("filterInput: an authorized protected field passes", () => {
  const { data } = filterInput(map, { email: "new@x.com" }, { op: "update", actor: user, authorized: ["email"] });
  assert.deepEqual(data, { email: "new@x.com" });
});

test("filterInput: non-object input is returned untouched", () => {
  assert.deepEqual(filterInput(map, null), { data: null, dropped: [] });
});

test("guardedChanges: only protected/system, only real changes, minus authorized", () => {
  const original = { email: "a@b.c", mfa_enabled: "1", total: "5", password: "h" };
  const current = { email: "x@y.z", mfa_enabled: 0, total: "6", password: "h" };
  assert.deepEqual(guardedChanges(map, original, current).sort(), ["email", "mfa_enabled"]);
  assert.deepEqual(guardedChanges(map, original, current, ["email", "mfa_enabled"]), []);
  // unchanged values (normalized) are not changes
  assert.deepEqual(guardedChanges(map, { mfa_enabled: "1" }, { mfa_enabled: 1 }), []);
  assert.deepEqual(guardedChanges(map, { mfa_enabled: null }, { mfa_enabled: "" }), []);
});

test("comparable normalizes like the database", () => {
  assert.equal(comparable(null), "");
  assert.equal(comparable(true), "1");
  assert.equal(comparable({ a: 1 }), '{"a":1}');
  assert.equal(comparable(5), "5");
});

test("renderLock: what the form shows per policy", () => {
  assert.deepEqual(renderLock({ ...map.email, name: "email" }, { isNew: false, actor: user }),
    { readonly: 1, protected_change: 1 });
  assert.equal(renderLock({ ...map.email, name: "email" }, { isNew: true, actor: user }), null);
  assert.deepEqual(renderLock({ ...map.mfa_enabled, name: "mfa_enabled" }, { actor: user }), { readonly: 1 });
  assert.deepEqual(renderLock({ ...map.name, name: "name" }, { isNew: false, actor: user }), { readonly: 1 });
  assert.equal(renderLock({ ...map.name, name: "name" }, { isNew: true, actor: user }), null);
  assert.deepEqual(renderLock({ ...map.user_type, name: "user_type" }, { actor: user }), { readonly: 1 });
  assert.equal(renderLock({ ...map.user_type, name: "user_type" }, { actor: { roles: ["HR"] } }), null);
  assert.equal(renderLock(map.first_name, { actor: user }), null);
});

test("canWriteFromInput: no rule = allowed", () => {
  assert.deepEqual(canWriteFromInput(undefined), { allowed: true });
});
