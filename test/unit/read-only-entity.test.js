import { test } from "node:test";
import assert from "node:assert/strict";
import { loopar } from "loopar";
import { isReadOnlyWrite } from "../../packages/loopar/core/auth/PermissionManager.js";

const refs = { "Webhook Event": { read_only: 1 }, Customer: { read_only: 0 } };

test("read-only entity: hand create/update are writes the desk refuses", (t) => {
  t.mock.method(loopar, "getRef", (name) => refs[name] || null);
  assert.equal(isReadOnlyWrite("Webhook Event", "create"), true);
  assert.equal(isReadOnlyWrite("Webhook Event", "Update"), true);
});

test("read-only entity: reading, deleting and custom actions stay allowed", (t) => {
  t.mock.method(loopar, "getRef", (name) => refs[name] || null);
  for (const action of ["list", "view", "delete", "print", "portalAccess"]) {
    assert.equal(isReadOnlyWrite("Webhook Event", action), false, action);
  }
  assert.equal(isReadOnlyWrite("Customer", "update"), false);
  assert.equal(isReadOnlyWrite("Missing", "create"), false);
});
