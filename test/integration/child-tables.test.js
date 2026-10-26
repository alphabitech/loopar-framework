import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { loopar } from "loopar";
import { KnexORM } from "db-env";
import { bootTestTenant } from "../support/tenant.js";

/**
 * Child tables (form_table) read and written by server code. Uses Workflow →
 * Workflow Transition: several transition fields (confirm, style, method…)
 * are not in the list view, and a workflow may have more rows than a list page.
 */
const ROWS = 12;
let t;

const transitions = () => loopar.db.qx()("Workflow Transition")
  .where({ parent_document: "Workflow" }).orderBy("id").select("name", "action", "confirm", "style");

before(async () => {
  t = await bootTestTenant();
  await t.run(async () => {
    await (await loopar.newDocument("Workflow", {
      document: "Letterhead",
      state_field: "company_name",
      states: [{ state: "A", is_initial: 1 }, { state: "B" }],
      transitions: Array.from({ length: ROWS }, (_, i) => ({
        action: `Move ${i}`, from_state: "A", to_state: "B", confirm: `Sure ${i}?`,
      })),
    })).save();
  });
});
after(async () => { await t?.teardown(); });

test("children are saved with every field", async () => {
  await t.run(async () => {
    const rows = await transitions();
    assert.equal(rows.length, ROWS);
    assert.ok(rows.every((r) => r.confirm?.startsWith("Sure")));
  });
});

test("the child table getter returns every row and every field", async () => {
  await t.run(async () => {
    const doc = await loopar.getDocument("Workflow", "Letterhead");
    const rows = await doc.transitions;
    assert.equal(rows.length, ROWS);
    assert.ok(rows.every((r) => r.confirm?.startsWith("Sure")), "fields outside the list view are kept");
  });
});

test("saving a loaded document keeps its children", async () => {
  await t.run(async () => {
    const doc = await loopar.getDocument("Workflow", "Letterhead");
    doc.active = 1;
    await doc.save();
    const rows = await transitions();
    assert.equal(rows.length, ROWS);
    assert.ok(rows.every((r) => r.confirm?.startsWith("Sure")));
  });
});

test("editing one child row from server code keeps the others' fields", async () => {
  await t.run(async () => {
    const doc = await loopar.getDocument("Workflow", "Letterhead");
    const rows = await doc.transitions;
    rows[0].style = "primary";
    doc.transitions = rows;
    await doc.save();

    const saved = await transitions();
    assert.equal(saved.length, ROWS);
    assert.ok(saved.every((r) => r.confirm?.startsWith("Sure")));
    assert.equal(saved.filter((r) => r.style === "primary").length, 1);
  });
});

test("values() lists every child row and field", async () => {
  await t.run(async () => {
    const doc = await loopar.getDocument("Workflow", "Letterhead");
    const values = await doc.values();
    const rows = Array.isArray(values.transitions) ? values.transitions : JSON.parse(values.transitions || "[]");
    assert.equal(rows.length, ROWS);
    assert.ok(rows.every((r) => r.confirm?.startsWith("Sure")));
  });
});

test("a child row that fails validation leaves the saved children untouched", async () => {
  await t.run(async () => {
    const doc = await loopar.getDocument("Workflow", "Letterhead");
    const rows = await doc.transitions;
    rows.push({ from_state: "A", to_state: "B" });   // no action: required
    doc.transitions = rows;
    await assert.rejects(() => doc.save());

    const saved = await transitions();
    assert.equal(saved.length, ROWS);
  });
});

test("a child row that fails while saving leaves the saved children untouched", async () => {
  await t.run(async () => {
    const doc = await loopar.getDocument("Workflow", "Letterhead");
    const rows = await doc.transitions;
    rows.unshift({ action: "Boom", from_state: "A", to_state: "B" });
    doc.transitions = rows;

    // A child whose insert fails (a hook, a constraint…).
    const boom = async ({ doc }) => { if (doc?.action === "Boom") throw new Error("child failed"); };
    KnexORM.on("beforeCreate:Workflow Transition", boom);
    try {
      await assert.rejects(() => doc.save(), /child failed/);
    } finally {
      KnexORM.off("beforeCreate:Workflow Transition", boom);
    }

    const saved = await transitions();
    assert.equal(saved.length, ROWS);
    assert.ok(saved.every((r) => r.confirm?.startsWith("Sure")));
  });
});

test("rows keep their name across saves; only new rows get one", async () => {
  await t.run(async () => {
    const before = (await transitions()).map((r) => r.name);
    const doc = await loopar.getDocument("Workflow", "Letterhead");
    const rows = await doc.transitions;
    rows.reverse();                                        // reordered in the form
    rows.push({ action: "Extra", from_state: "A", to_state: "B", name: "1712345678901" }); // client temp name
    doc.transitions = rows;
    await doc.save();

    const after = await loopar.db.qx()("Workflow Transition")
      .where({ parent_document: "Workflow" }).orderBy("id").select("name", "action");
    assert.equal(after.length, ROWS + 1);
    assert.deepEqual(after.slice(0, ROWS).map((r) => r.name), [...before].reverse(), "same names, new order");
    assert.notEqual(after[ROWS].name, "1712345678901", "a new row gets its own name");
    assert.equal(after[ROWS].action, "Extra");

    // Back to the original rows for the other tests.
    const back = await loopar.getDocument("Workflow", "Letterhead");
    back.transitions = (await back.transitions).filter((r) => r.action !== "Extra").reverse();
    await back.save();
  });
});

test("rows of another parent entity with the same parent_id are left alone", async () => {
  await t.run(async () => {
    const wf = await loopar.getDocument("Workflow", "Letterhead");
    const parentId = await wf.__ID__();
    await loopar.db.qx()("Workflow Transition").insert({
      id: 900000, name: "foreign-row", parent_id: parentId, parent_document: "Some Other Parent",
      action: "Foreign", from_state: "X", to_state: "Y",
    });

    assert.ok(!(await wf.transitions).some((r) => r.name === "foreign-row"), "not read as a child of the workflow");
    wf.transitions = await wf.transitions;
    await wf.save();
    assert.equal(await loopar.db.count("Workflow Transition", { name: "foreign-row" }), 1, "not deleted by its save");
    assert.equal((await transitions()).length, ROWS);
  });
});

test("an open transaction belongs to the request that opened it", async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  let opened;
  const opener = t.run(async () => {
    await loopar.db.beginTransaction();
    opened();
    await held;
    await loopar.db.safeRollback();
  });
  await new Promise((r) => { opened = r; });
  await t.run(async () => {
    assert.equal(loopar.db.transaction, null, "another request does not see it");
  });
  release();
  await opener;
});
