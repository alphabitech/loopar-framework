import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { loopar, orderChildRows } from "loopar";
import { KnexORM } from "db-env";
import { bootTestTenant } from "../support/tenant.js";

/**
 * Child tables (form_table) read and written by server code. Uses Workflow →
 * Workflow Transition: several transition fields (confirm, style, method…)
 * are not in the list view, and a workflow may have more rows than a list page.
 */
const ROWS = 12;
let t;

const transitions = () => orderChildRows(loopar.db.qx()("Workflow Transition")
  .where({ parent_document: "Workflow" })).select("id", "name", "action", "confirm", "style");

/** Counts the inserts and updates of `entity` made while `fn` runs. */
async function countWrites(entity, fn) {
  const writes = { created: 0, updated: 0 };
  const onCreate = () => { writes.created++; };
  const onUpdate = () => { writes.updated++; };
  KnexORM.on(`beforeCreate:${entity}`, onCreate);
  KnexORM.on(`beforeUpdate:${entity}`, onUpdate);
  try { await fn(); } finally {
    KnexORM.off(`beforeCreate:${entity}`, onCreate);
    KnexORM.off(`beforeUpdate:${entity}`, onUpdate);
  }
  return writes;
}

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

test("reordering keeps every row (same id and name) and only writes the moved ones", async () => {
  await t.run(async () => {
    const before = await transitions();
    const doc = await loopar.getDocument("Workflow", "Letterhead");
    const rows = await doc.transitions;
    rows.reverse();
    rows.push({ action: "Extra", from_state: "A", to_state: "B", name: "1712345678901" }); // client temp name
    doc.transitions = rows;
    const writes = await countWrites("Workflow Transition", () => doc.save());

    const after = await transitions();
    assert.equal(after.length, ROWS + 1);
    assert.deepEqual(after.slice(0, ROWS).map((r) => [r.id, r.name]), [...before].reverse().map((r) => [r.id, r.name]));
    assert.notEqual(after[ROWS].name, "1712345678901", "a new row gets its own name");
    assert.equal(after[ROWS].action, "Extra");
    assert.deepEqual(writes, { created: 1, updated: ROWS }, "every old row moved, one new");

    // Back to the original rows for the other tests.
    const back = await loopar.getDocument("Workflow", "Letterhead");
    back.transitions = (await back.transitions).filter((r) => r.action !== "Extra").reverse();
    await back.save();
    assert.deepEqual((await transitions()).map((r) => r.name), before.map((r) => r.name));
  });
});

test("saving unchanged rows writes nothing; one change writes one row", async () => {
  await t.run(async () => {
    const doc = await loopar.getDocument("Workflow", "Letterhead");
    doc.transitions = await doc.transitions;
    assert.deepEqual(await countWrites("Workflow Transition", () => doc.save()), { created: 0, updated: 0 });

    const again = await loopar.getDocument("Workflow", "Letterhead");
    const rows = await again.transitions;
    rows[3].confirm = "Changed?";
    again.transitions = rows;
    assert.deepEqual(await countWrites("Workflow Transition", () => again.save()), { created: 0, updated: 1 });

    const saved = await transitions();
    assert.equal(saved[3].confirm, "Changed?");
    assert.equal(saved[3].name, rows[3].name);
    saved[3].confirm = "Sure 3?";
    const restore = await loopar.getDocument("Workflow", "Letterhead");
    const restoreRows = await restore.transitions;
    restoreRows[3].confirm = "Sure 3?";
    restore.transitions = restoreRows;
    await restore.save();
  });
});

test("a row sent with only some fields keeps the others", async () => {
  await t.run(async () => {
    const doc = await loopar.getDocument("Workflow", "Letterhead");
    // `confirm` not sent (the workflow itself needs action and states).
    const rows = (await doc.transitions).map((r, i) => (i === 0
      ? { name: r.name, action: r.action, from_state: r.from_state, to_state: r.to_state, style: "primary" }
      : r));
    doc.transitions = rows;
    await doc.save();

    const first = (await transitions())[0];
    assert.equal(first.style, "primary");
    assert.equal(first.confirm, "Sure 0?", "fields not sent are kept");
    assert.equal(first.action, "Move 0");
  });
});

test("rows no longer sent are deleted; the rest keep their ids", async () => {
  await t.run(async () => {
    const before = await transitions();
    const doc = await loopar.getDocument("Workflow", "Letterhead");
    doc.transitions = (await doc.transitions).filter((r) => r.action !== "Move 5");
    await doc.save();

    const after = await transitions();
    assert.equal(after.length, ROWS - 1);
    assert.deepEqual(after.map((r) => r.id), before.filter((r) => r.action !== "Move 5").map((r) => r.id));

    const back = await loopar.getDocument("Workflow", "Letterhead");
    const rows = await back.transitions;
    rows.splice(5, 0, { action: "Move 5", from_state: "A", to_state: "B", confirm: "Sure 5?" });
    back.transitions = rows;
    await back.save();
    assert.equal((await transitions())[5].action, "Move 5");
  });
});

test("an updated row is validated by its model", async () => {
  await t.run(async () => {
    const doc = await loopar.getDocument("Workflow", "Letterhead");
    const rows = await doc.transitions;
    rows[2].action = "";                                   // required
    doc.transitions = rows;
    await assert.rejects(() => doc.save());
    assert.equal((await transitions())[2].action, "Move 2");
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
