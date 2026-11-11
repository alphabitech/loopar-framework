import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { loopar, Op, PermissionManager } from "loopar";
import { bootTestTenant } from "../support/tenant.js";

/**
 * Submodules: a Module with `parent_module` leaves the sidebar and its
 * documents are reached through the parent. Rows are written directly:
 * Module.save() creates the module folder inside the app.
 */
const SUB = "subtest";
let t;
before(async () => {
  t = await bootTestTenant();
  await t.run(async () => {
    const all = await loopar.db.qx()("Module").select("*"); const parent = all.find(m => m.name === "Integrations");
    const { id, ...row } = parent;
    await loopar.db.qx()("Module").insert({ ...row, name: SUB, description: "Sub test", parent_module: "Integrations" });
    await loopar.db.qx()("Entity").where({ name: "Turnstile" }).update({ module: SUB });
    await loopar.build();
  });
});
after(async () => { await t?.teardown(); });

const menuModules = () => (loopar.deskMenu || []).flatMap(app => app.modules || []);

test("a submodule is not a sidebar entry; its parent lists it and owns its routes", async () => {
  await t.run(async () => {
    const modules = menuModules();
    assert.equal(modules.some(m => m.link === SUB), false);

    const parent = modules.find(m => m.link === "Integrations");
    assert.ok(parent.submodules.includes(SUB));
    assert.ok(parent.routes.some(r => r.description === "Turnstile"), "submodule documents keep the parent active");
    assert.ok(PermissionManager.submodulesOf("Integrations").includes(SUB));
  });
});

test("parent validation: one level, same app, not itself", async () => {
  await t.run(async () => {
    const check = async (data) => (await loopar.newDocument("Module", { app_name: "loopar", ...data })).validateParent();

    await assert.rejects(check({ name: "x", parent_module: "x" }), /own parent/);
    await assert.rejects(check({ name: "x", parent_module: SUB }), /one level deep/);
    await assert.rejects(check({ name: "x", parent_module: "nope" }), /does not exist/);
    await assert.rejects(check({ name: "x", app_name: "other", parent_module: "Integrations" }), /another app/);
    await check({ name: "x", parent_module: "Integrations" });
    await check({ name: "x" });
  });
});

test("getList() takes a page size, so a grouped module page lists everything at once", async () => {
  await t.run(async () => {
    const inModule = { module: { [Op.in]: ["Integrations", SUB] } };
    const total = await loopar.db.count("Entity", inModule);
    const list = await loopar.getList("Entity", { filters: inModule, page: 1, pageSize: 500, q: {} });

    assert.equal(list.rows.length, total);
    assert.equal(list.pagination.totalPages, 1);
    assert.ok(list.rows.some(r => r.name === "Turnstile"));
  });
});
