import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { loopar, PermissionManager } from "loopar";
import { bootTestTenant } from "../support/tenant.js";

/**
 * PermissionManager.scope(document, action, user) → 'all' | 'own' | null,
 * resolved from role grants (Role → Permission rows), user grants and user
 * denies. Rows are written straight to the DB and the user is reloaded, the
 * same thing the ORM hooks do after a save.
 */
let t;
before(async () => { t = await bootTestTenant(); });
after(async () => { await t?.teardown(); });

let seq = 0;
const grant = (relation, relation_name, document, action, { scope = "all", deny = 0 } = {}) =>
  loopar.db.insertRow("Permission", {
    name: `test-${relation}-${relation_name}-${document}-${action}-${++seq}`,
    relation, relation_name, document, action, scope, deny, app: "loopar",
  });

const giveRole = (user, role) =>
  loopar.db.insertRow("User Role", { name: `${user}-${role}-${++seq}`, user, role });

const user = async (name, setup = async () => {}) => {
  await setup(name);
  await PermissionManager.reload(name);
  return name;
};

test("Administrator always has full scope", async () => {
  await t.run(async () => {
    assert.equal(PermissionManager.scope("App", "delete", "Administrator"), "all");
  });
});

test("a user without roles or grants is denied", async () => {
  await t.run(async () => {
    const u = await user("nobody");
    assert.equal(PermissionManager.scope("App", "view", u), null);
    assert.equal(PermissionManager.can("App", "view", u), false);
  });
});

test("System Manager (*:*) reaches every document and action", async () => {
  await t.run(async () => {
    const u = await user("sysman", (n) => giveRole(n, "System Manager"));
    assert.equal(PermissionManager.scope("Entity", "update", u), "all");
    assert.equal(PermissionManager.scope("Anything Else", "custom", u), "all");
  });
});

test("Desk User reaches Profile but no application data", async () => {
  await t.run(async () => {
    const u = await user("desker", (n) => giveRole(n, "Desk User"));
    assert.equal(PermissionManager.scope("Profile", "update", u), "all");
    assert.equal(PermissionManager.scope("App", "list", u), null);
  });
});

test("a grant with scope 'own' resolves to 'own'", async () => {
  await t.run(async () => {
    const u = await user("owner", (n) => grant("User", n, "App", "update", { scope: "own" }));
    assert.equal(PermissionManager.scope("App", "update", u), "own");
    assert.equal(PermissionManager.can("App", "update", u), true);
  });
});

test("the widest scope wins between a role and a user grant", async () => {
  await t.run(async () => {
    await grant("Role", "Test Editors", "App", "update", { scope: "all" });
    const u = await user("mixed", async (n) => {
      await giveRole(n, "Test Editors");
      await grant("User", n, "App", "update", { scope: "own" });
    });
    assert.equal(PermissionManager.scope("App", "update", u), "all");
  });
});

test("a user deny overrides what a role grants", async () => {
  await t.run(async () => {
    const u = await user("denied", async (n) => {
      await giveRole(n, "System Manager");
      await grant("User", n, "App", "delete", { deny: 1 });
    });
    assert.equal(PermissionManager.scope("App", "delete", u), null);
    assert.equal(PermissionManager.scope("App", "update", u), "all");
  });
});

test("an App:<app> grant covers every document of that app", async () => {
  await t.run(async () => {
    const u = await user("appwide", (n) => grant("User", n, "App:loopar", "view"));
    assert.equal(PermissionManager.scope("Entity", "view", u), "all");
    assert.equal(PermissionManager.scope("Entity", "delete", u), null);
  });
});

test("document:* and *:action wildcards apply", async () => {
  await t.run(async () => {
    const u = await user("wild", async (n) => {
      await grant("User", n, "Module", "*");
      await grant("User", n, "*", "list");
    });
    assert.equal(PermissionManager.scope("Module", "delete", u), "all");
    assert.equal(PermissionManager.scope("App", "list", u), "all");
    assert.equal(PermissionManager.scope("App", "update", u), null);
  });
});

test("action and document names are matched case- and space-insensitively", async () => {
  await t.run(async () => {
    const u = await user("casing", (n) => grant("User", n, "User Role", "View"));
    assert.equal(PermissionManager.scope("userrole", "view", u), "all");
  });
});
