import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { loopar, formulaRefValues, formulaRefIssues } from "loopar";
import { bootTestTenant } from "../support/tenant.js";

/*
 * References in formulas (`link.field`): Module.app_description is a virtual
 * `app_name.description`; a stored formula copies the value on save.
 */

let t;
before(async () => { t = await bootTestTenant(); });
after(async () => { await t?.teardown(); });

test("Module.app_description: virtual, read from the App the module belongs to", async () => {
  await t.run(async () => {
    await loopar.db.qx()("App").where({ name: "loopar" }).update({ description: "The framework" });
    const ref = loopar.getRef("Module");
    assert.deepEqual(ref.__VIRTUAL__, { app_description: "app_name.description" });
    assert.ok(!ref.__FIELDS__.includes("app_description"));

    const list = await (await loopar.newDocument("Module")).getList({ fields: ["name", "app_name", "app_description"], rowsOnly: true });
    const core = list.rows.find((r) => r.name === "core");
    assert.equal(core.app_description, "The framework");
    assert.ok(!Object.keys(core).some((k) => k.includes(".")), "references stay out of the row");

    const module = await loopar.getDocument("Module", "core");
    assert.equal((await module.rawValues()).app_description, "The framework");
  });
});

test("formulaRefValues: one lookup per connection for every row", async () => {
  await t.run(async () => {
    const refsOf = await formulaRefValues("Module", { x: "app_name.description", y: "app_name.version" }, [
      { app_name: "loopar" }, { app_name: "loopar" }, { app_name: "missing-app" }, { app_name: null },
    ]);
    assert.equal(refsOf({ app_name: "loopar" })["app_name.description"], "The framework");
    assert.ok(refsOf({ app_name: "loopar" })["app_name.version"]);
    assert.deepEqual(refsOf({ app_name: "missing-app" }), { "app_name.description": null, "app_name.version": null });
  });
});

test("a stored formula copies the linked value on save and keeps it", async () => {
  await t.run(async () => {
    const ref = loopar.getRef("Module");
    const saved = ref.__FORMULAS__;
    ref.__FORMULAS__ = { ...saved, description: "app_name.description" };
    try {
      const module = await loopar.newDocument("Module", { name: "refs_probe", app_name: "loopar" });
      await module.save();
      assert.equal(await loopar.db.getValue("Module", "description", "refs_probe"), "The framework");

      await loopar.db.qx()("App").where({ name: "loopar" }).update({ description: "Changed later" });
      assert.equal(await loopar.db.getValue("Module", "description", "refs_probe"), "The framework", "a stored copy does not follow the source");
    } finally {
      ref.__FORMULAS__ = saved;
    }
  });
});

test("fetch_if_empty: fills an empty field on save, keeps what was written", async () => {
  await t.run(async () => {
    await loopar.db.qx()("App").where({ name: "loopar" }).update({ description: "Default text" });
    const ref = loopar.getRef("Module");
    const saved = { formulas: ref.__FORMULAS__, ifEmpty: ref.__FETCH_IF_EMPTY__ };
    ref.__FORMULAS__ = { ...saved.formulas, description: "app_name.description" };
    ref.__FETCH_IF_EMPTY__ = ["description"];
    try {
      await (await loopar.newDocument("Module", { name: "fie_empty", app_name: "loopar" })).save();
      assert.equal(await loopar.db.getValue("Module", "description", "fie_empty"), "Default text");

      await (await loopar.newDocument("Module", { name: "fie_written", app_name: "loopar", description: "Mine" })).save();
      assert.equal(await loopar.db.getValue("Module", "description", "fie_written"), "Mine");

      const cleared = await loopar.getDocument("Module", "fie_written");
      // A loaded document carries its own copy of the ref: patch it too.
      Object.assign(cleared.__ENTITY__.__REF__, { __FORMULAS__: ref.__FORMULAS__, __FETCH_IF_EMPTY__: ["description"] });
      cleared.description = "";
      await cleared.save();
      assert.equal(await loopar.db.getValue("Module", "description", "fie_written"), "Default text", "left empty: filled again");
    } finally {
      ref.__FORMULAS__ = saved.formulas;
      ref.__FETCH_IF_EMPTY__ = saved.ifEmpty;
    }
  });
});

test("formulaRefIssues: connection, single, existing stored field, no passwords", async () => {
  await t.run(async () => {
    const f = (element, data) => ({ element, data });
    const fields = [
      f("connection", { name: "app_name", options: "App" }),
      f("connection", { name: "apps", options: "App", multiple: 1 }),
      f("input", { name: "title" }),
      f("connection", { name: "owner", options: "User" }),
    ];
    const issues = (formula) => formulaRefIssues([...fields, f("input", { name: "x", formula })]);
    assert.deepEqual(issues("app_name.description"), []);
    assert.deepEqual(issues("app_name.name"), []);
    assert.match(issues("title.description")[0], /not a connection/);
    assert.match(issues("apps.description")[0], /several records/);
    assert.match(issues("app_name.nope")[0], /no stored field nope/);
    assert.match(issues("owner.password")[0], /password/);
  });
});
