import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loopar } from "loopar";
import { bootTestTenant } from "../support/tenant.js";

/*
 * An app's declared role replaces the convention's role of the same name in
 * any case ("ERP Manager" vs "Erp Manager"), and a duplicate left by an older
 * install is retired: its users move to the declared role, its grants go.
 */

let t, Installer;
before(async () => {
  t = await bootTestTenant({ apps: ["erp"] });
  Installer = (await import(path.join(process.cwd(), "apps", "erp", "installer.js"))).default;
});
after(async () => { await t?.teardown(); });

const roles = () => loopar.db.getAll("Role", ["name"], { app: "erp" }).then((r) => r.map((x) => x.name).sort());

test("no role differs from a declared one only in case", async () => {
  await t.run(async () => {
    assert.deepEqual(await roles(), ["ERP Manager", "ERP User", "HR Manager", "POS User"]);
  });
});

test("an older install's duplicate is retired; its users keep their access under the declared role", async () => {
  await t.run(async () => {
    await loopar.db.insertRow("Role", { name: "Erp Manager", app: "erp", is_system_role: 1, disabled: 0, description: "old" });
    await loopar.db.insertRow("Permission", { name: "Role-Erp Manager-App:erp-*", relation: "Role", relation_name: "Erp Manager", document: "App:erp", action: "*", app: "erp", deny: 0, scope: "all" });
    await loopar.db.insertRow("User Role", { name: "ur-dup-1", user: "Administrator", role: "Erp Manager" });

    await new Installer({ app_name: "erp" }).seedRoles();

    assert.deepEqual(await roles(), ["ERP Manager", "ERP User", "HR Manager", "POS User"]);
    assert.equal((await loopar.db.getAll("Permission", ["name"], { relation: "Role", relation_name: "Erp Manager" })).length, 0, "no grant left on it");
    assert.deepEqual((await loopar.db.getAll("User Role", ["role"], { user: "Administrator", role: "ERP Manager" })).length, 1);
  });
});
