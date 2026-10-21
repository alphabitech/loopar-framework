import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { loopar } from "loopar";
import { bootTestTenant } from "../support/tenant.js";

/**
 * Entity names are unique per tenant: meta tables (Entity + every builder
 * table) are UNIQUE(name), a second record with the same name is refused, and
 * refs resolve by name.
 */
const META_TABLES = ["Entity", "Builder", "Page Builder", "Form Builder", "View Builder",
  "Controller Builder", "Contact Form Builder", "Print Format Builder"];

let t;
before(async () => { t = await bootTestTenant(); });
after(async () => { await t?.teardown(); });

const indexesOf = (table) => loopar.db.raw(
  "select name from sqlite_master where type = 'index' and tbl_name = ?", [table]
).then(rows => rows.map(r => r.name));

test("meta tables are unique by name", async () => {
  await t.run(async () => {
    for (const table of META_TABLES) {
      const idx = await indexesOf(table);
      assert.ok(idx.includes(`${table.toLowerCase()}_name_unique`), `${table}: UNIQUE(name)`);
      assert.ok(!idx.includes(`${table.toLowerCase()}_module_name_unique`), `${table}: no UNIQUE(module, name)`);
    }
  });
});

test("a second meta record with the same name is refused, even in another module", async () => {
  await t.run(async () => {
    await loopar.db.insertRow("Page Builder", { name: "Solo Page", module: "core", doc_structure: "[]" });
    await assert.rejects(
      loopar.db.insertRow("Page Builder", { name: "Solo Page", module: "zz-foreign", doc_structure: "[]" }),
      /unique/i,
    );
  });
});

test("ensureNameUniqueKey restores UNIQUE(name) and is idempotent", async () => {
  await t.run(async () => {
    await loopar.db.ensureNameUniqueKey("Page Builder");
    await loopar.db.ensureNameUniqueKey("Page Builder");
    const idx = await indexesOf("Page Builder");
    assert.ok(idx.includes("page builder_name_unique"));
  });
});

test("refs resolve by name", async () => {
  await t.run(async () => {
    assert.equal(loopar.getRef("User")?.__APP__, "loopar");
    assert.equal(loopar.getRef("Nope Entity"), null);
  });
});
