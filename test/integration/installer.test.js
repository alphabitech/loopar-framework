import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { loopar } from "loopar";
import { bootTestTenant, ADMIN } from "../support/tenant.js";

let t;
before(async () => { t = await bootTestTenant(); });
after(async () => { await t?.teardown(); });

test("a fresh install marks the tenant installed with the loopar app", async () => {
  await t.run(async () => {
    assert.equal(loopar.__installed__, true);
    const apps = await loopar.db.getAll("App", ["name"]);
    assert.deepEqual(apps.map((a) => a.name), ["loopar"]);
  });
});

test("core entities are registered and their tables exist", async () => {
  await t.run(async () => {
    for (const entity of ["Entity", "Module", "App", "User", "Role", "User Role", "Permission"]) {
      assert.ok(loopar.getRef(entity), `ref for ${entity}`);
      assert.ok(await loopar.db.count("Entity", { name: entity }) === 1, `Entity record for ${entity}`);
    }
  });
});

test("the Administrator user is created with the installer's email", async () => {
  await t.run(async () => {
    const admin = await loopar.db.getDoc("User", "Administrator", ["name", "email"]);
    assert.equal(admin?.name, "Administrator");
    assert.equal(admin?.email, ADMIN.email);
  });
});

test("system roles are seeded with their grants", async () => {
  await t.run(async () => {
    const roles = (await loopar.db.getAll("Role", ["name"])).map((r) => r.name);
    for (const role of ["System Manager", "Desk User", "Web User"]) {
      assert.ok(roles.includes(role), `role ${role}`);
    }
    const grants = await loopar.db.getAll("Permission", ["document", "action"], {
      relation: "Role", relation_name: "System Manager",
    });
    assert.deepEqual(grants.map((g) => `${g.document}:${g.action}`), ["*:*"]);
  });
});

test("reinstalling (app update) is idempotent: no duplicate roles or grants", async () => {
  await t.run(async () => {
    const count = async () => ({
      roles: await loopar.db.count("Role", { app: "loopar" }),
      grants: (await loopar.db.getAll("Permission", ["name"], { relation: "Role" })).length,
      entities: (await loopar.db.getAll("Entity", ["name"])).length,
    });
    const beforeUpdate = await count();

    const { default: Installer } = await import(`${process.cwd()}/apps/loopar/installer.js`);
    await new Installer({ app_name: "loopar" }).install(true);

    assert.deepEqual(await count(), beforeUpdate);
  });
});
