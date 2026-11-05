import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { loopar, Op, DOC_STATUS } from "loopar";
import { bootTestTenant } from "../support/tenant.js";

/**
 * Document lifecycle and the ORM read API, on a real entity (Letterhead:
 * `name` required + unique, `tagline` text, `is_default` switch).
 */
let t;
before(async () => {
  t = await bootTestTenant();
  await t.run(async () => {
    for (const [name, company] of [["Alpha", "Alpha Co"], ["Beta", "Beta LLC"], ["Gamma", "Gamma Co"],
      ["Delta", "Delta Inc"], ["Epsilon", "Epsilon Co"], ["Zeta", "Zeta Co"], ["Eta", "Eta Co"]]) {
      await (await loopar.newDocument("Letterhead", { name, tagline: company })).save();
    }
  });
});
after(async () => { await t?.teardown(); });

test("save() inserts the row with its audit columns", async () => {
  await t.run(async () => {
    const row = await loopar.db.getDoc("Letterhead", "Alpha");
    assert.equal(row.tagline, "Alpha Co");
    assert.ok(row.__created_at__, "__created_at__");
    assert.equal(Number(row.__document_status__), DOC_STATUS.ACTIVE);
    assert.equal(row.__deleted_at__, null);
  });
});

test("getDocument() loads a saved record as a document", async () => {
  await t.run(async () => {
    const doc = await loopar.getDocument("Letterhead", "Beta");
    assert.equal(doc.name, "Beta");
    assert.equal(doc.tagline, "Beta LLC");
  });
});

test("getDoc() with an object filter returns the matching row, not the first one", async () => {
  await t.run(async () => {
    const row = await loopar.db.getDoc("Letterhead", { tagline: "Delta Inc" }, ["name"]);
    assert.equal(row?.name, "Delta");
  });
});

test("getDoc(document, filter) — two arguments — also filters", async () => {
  await t.run(async () => {
    const row = await loopar.db.getDoc("Letterhead", { tagline: "Epsilon Co" });
    assert.equal(row?.name, "Epsilon");
  });
});

test("getValue() reads one field by name", async () => {
  await t.run(async () => {
    assert.equal(await loopar.db.getValue("Letterhead", "tagline", "Gamma"), "Gamma Co");
  });
});

test("getList() is paginated; getAll() returns every row", async () => {
  await t.run(async () => {
    const page = await loopar.db.getList("Letterhead", ["name"]);
    const all = await loopar.db.getAll("Letterhead", ["name"]);
    assert.equal(all.length, 7);
    assert.ok(page.length < all.length, `getList returned ${page.length} of ${all.length}`);
  });
});

test("filters support Op.in, Op.like and Op.ne", async () => {
  await t.run(async () => {
    const names = (rows) => rows.map((r) => r.name).sort();
    assert.deepEqual(names(await loopar.db.getAll("Letterhead", ["name"], { name: { [Op.in]: ["Alpha", "Zeta"] } })), ["Alpha", "Zeta"]);
    assert.deepEqual(names(await loopar.db.getAll("Letterhead", ["name"], { tagline: { [Op.like]: "% Co" } })),
      ["Alpha", "Epsilon", "Eta", "Gamma", "Zeta"]);
    assert.equal((await loopar.db.getAll("Letterhead", ["name"], { name: { [Op.ne]: "Alpha" } })).length, 6);
  });
});

test("count() counts rows matching a condition", async () => {
  await t.run(async () => {
    assert.equal(await loopar.db.count("Letterhead", { tagline: "Beta LLC" }), 1);
    assert.equal(await loopar.db.count("Letterhead", { tagline: "Nobody" }), 0);
  });
});

test("setValue() updates one field", async () => {
  await t.run(async () => {
    await loopar.db.setValue("Letterhead", "tagline", "Floors since 2010", "Eta");
    assert.equal(await loopar.db.getValue("Letterhead", "tagline", "Eta"), "Floors since 2010");
  });
});

test("saving an existing document updates it", async () => {
  await t.run(async () => {
    const doc = await loopar.getDocument("Letterhead", "Gamma");
    doc.footer = "(617) 555-0100";
    await doc.save();
    assert.equal(await loopar.db.getValue("Letterhead", "footer", "Gamma"), "(617) 555-0100");
  });
});

test("a model's save() hook runs (only one default Letterhead)", async () => {
  await t.run(async () => {
    const mark = async (name) => {
      const doc = await loopar.getDocument("Letterhead", name);
      doc.is_default = 1;
      await doc.save();
    };
    await mark("Alpha");
    await mark("Beta");
    const defaults = await loopar.db.getAll("Letterhead", ["name"], { is_default: 1 });
    assert.deepEqual(defaults.map((r) => r.name), ["Beta"]);
  });
});

test("a missing required field is rejected", async () => {
  await t.run(async () => {
    const doc = await loopar.newDocument("Legal Notice", { name: "no-title", app: "loopar" });
    await assert.rejects(() => doc.save(), /Title is required/);
    assert.equal(await loopar.db.count("Legal Notice", { name: "no-title" }), 0);
  });
});

// Rejected by the UNIQUE index (the message is the raw SQL error for now).
test("a duplicate name is rejected", async () => {
  await t.run(async () => {
    const doc = await loopar.newDocument("Letterhead", { name: "Alpha", tagline: "Again" });
    await assert.rejects(() => doc.save());
    assert.equal(await loopar.db.getValue("Letterhead", "tagline", "Alpha"), "Alpha Co");
  });
});

test("deleteDocument() soft-deletes: hidden from reads unless includeDeleted", async () => {
  await t.run(async () => {
    await loopar.deleteDocument("Letterhead", "Zeta");
    assert.equal(await loopar.db.getDoc("Letterhead", "Zeta"), null);
    assert.equal((await loopar.db.getAll("Letterhead", ["name"])).length, 6);
    const kept = await loopar.db.getAll("Letterhead", ["name", "__deleted_at__"], { name: "Zeta" }, { includeDeleted: true });
    assert.equal(kept.length, 1);
    assert.ok(kept[0].__deleted_at__);
  });
});
