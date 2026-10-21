import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { loopar } from "loopar";
import { bootTestTenant } from "../support/tenant.js";
import { rewriteRefs, applyRenameToDatabase } from "../../packages/loopar/core/document/entity-rename.js";

/**
 * Entity rename — the database part (replayed on every tenant) and the JSON
 * reference rewriting. The file part runs against the repo and is exercised
 * by hand / on a copy.
 */
let t;
before(async () => { t = await bootTestTenant(); });
after(async () => { await t?.teardown(); });

test("rewriteRefs: rewrites entity references, leaves everything else", () => {
  const doc = {
    doc_structure: JSON.stringify([
      { element: "select", data: { name: "link", options: "Old Thing" } },
      { element: "select", data: { name: "status", options: "Old Thing\nOther" } },
      { element: "collection", data: { options: "Old Thing" } },
      { element: "link", data: { to: "/desk/Old Thing/list" } },
      { element: "link", data: { to: "/desk/Old Things/list" } },
      { element: "text", data: { label: "Old Thing" } },
    ]),
    menu: [{ page: "Old Thing", link: "Old Thing" }],
  };
  const [out, changed] = rewriteRefs(doc, "Old Thing", "New Thing");
  assert.ok(changed);
  const ds = JSON.parse(out.doc_structure);
  assert.equal(ds[0].data.options, "New Thing", "entity link select");
  assert.equal(ds[1].data.options, "Old Thing\nOther", "static option list untouched");
  assert.equal(ds[2].data.options, "New Thing", "collection");
  assert.equal(ds[3].data.to, "/desk/New Thing/list", "desk link");
  assert.equal(ds[4].data.to, "/desk/Old Things/list", "a different entity's link untouched");
  assert.equal(ds[5].data.label, "Old Thing", "labels are text, untouched");
  assert.equal(out.menu[0].page, "New Thing", "menu page");

  const [same, none] = rewriteRefs({ options: "Something" }, "Old Thing", "New Thing");
  assert.equal(none, false);
  assert.deepEqual(same, { options: "Something" });
});

test("applyRenameToDatabase: meta row, table with data, references; idempotent", async () => {
  await t.run(async () => {
    const q = () => loopar.db.qx();
    await loopar.db.insertRow("Entity", { name: "Old Thing", module: "core", doc_structure: "[]" });
    await loopar.db.insertRow("Entity", {
      name: "Uses Old Thing", module: "core",
      doc_structure: JSON.stringify([{ element: "select", data: { name: "ref", options: "Old Thing" } }]),
    });
    await q().schema.createTable("Old Thing", tb => { tb.increments("id"); tb.string("name"); });
    await q()("Old Thing").insert([{ name: "a" }, { name: "b" }]);
    // The shell a booting tenant creates for the new name (files already renamed).
    await q().schema.createTable("New Thing", tb => { tb.increments("id"); tb.string("name"); });
    await q()("Document History").insert([
      { name: "h1", document: "Old Thing", document_name: "a", action: "update" },
      { name: "h2", document: "Entity", document_name: "Old Thing", action: "update" },
    ]);

    const report = await applyRenameToDatabase({ type: "Entity", from: "Old Thing", to: "New Thing" });
    assert.equal(report.meta, 1);
    assert.equal(report.table, true);

    assert.ok(await q()("Entity").where({ name: "New Thing" }).first(), "meta row renamed");
    assert.equal(await q()("Entity").where({ name: "Old Thing" }).first(), undefined);
    assert.equal(await q().schema.hasTable("Old Thing"), false, "old table gone");
    const rows = await q()("New Thing").select("name").orderBy("name");
    assert.deepEqual(rows.map(r => r.name), ["a", "b"], "data moved with the table, empty shell replaced");

    assert.equal((await q()("Document History").where({ name: "h1" }).first()).document, "New Thing");
    assert.equal((await q()("Document History").where({ name: "h2" }).first()).document_name, "New Thing");
    const user = await q()("Entity").where({ name: "Uses Old Thing" }).first();
    assert.equal(JSON.parse(user.doc_structure)[0].data.options, "New Thing", "references in doc_structure");

    const again = await applyRenameToDatabase({ type: "Entity", from: "Old Thing", to: "New Thing" });
    assert.equal(again.meta, 0, "second run is a no-op");
    assert.equal(again.table, false);
  });
});

test("applyRenameToDatabase refuses to overwrite a non-empty target table", async () => {
  await t.run(async () => {
    const q = () => loopar.db.qx();
    await loopar.db.insertRow("Entity", { name: "Src Thing", module: "core", doc_structure: "[]" });
    await q().schema.createTable("Src Thing", tb => { tb.increments("id"); tb.string("name"); });
    await q().schema.createTable("Dst Thing", tb => { tb.increments("id"); tb.string("name"); });
    await q()("Dst Thing").insert({ name: "keep me" });

    await assert.rejects(
      applyRenameToDatabase({ type: "Entity", from: "Src Thing", to: "Dst Thing" }),
      /already exists with 1 rows/,
    );
    assert.equal((await q()("Dst Thing").first()).name, "keep me");
  });
});
