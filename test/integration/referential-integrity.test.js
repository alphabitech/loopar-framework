import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { loopar } from "loopar";
import { bootTestTenant } from "../support/tenant.js";
import { withoutReferenceChecks, connectedDocuments } from "../../packages/loopar/core/document/referential-integrity.js";

/**
 * Referential integrity of connection fields in the ORM write pipeline
 * (core/document/referential-integrity.js). Writes go straight to loopar.db —
 * no document model — to prove the guard doesn't depend on it.
 *
 * Fixtures: AI Model.ai_provider → AI Provider; AI (single).ai_model → AI Model.
 */
let t;
before(async () => {
  t = await bootTestTenant();
  await t.run(async () => {
    for (const name of ["P1", "P2", "P3"]) await loopar.db.insertRow("AI Provider", { name });
    await loopar.db.insertRow("AI Model", { name: "M1", ai_provider: "P1" });
  });
});
after(async () => { await t?.teardown(); });

const rejects = (fn, re) => assert.rejects(fn, (e) => re.test(String(e?.message ?? e)));

test("create: a connection to a missing record is refused", async () => {
  await t.run(async () => {
    await rejects(
      () => loopar.db.insertRow("AI Model", { name: "M-bad", ai_provider: "Nope" }),
      /The value Nope for ai_provider does not exist in AI Provider/
    );
    assert.equal(await loopar.db.count("AI Model", "M-bad"), 0);
  });
});

test("update: a changed connection is checked", async () => {
  await t.run(async () => {
    await rejects(
      () => loopar.db.updateRow("AI Model", "M1", { ai_provider: "Nope" }),
      /does not exist in AI Provider/
    );
    await loopar.db.updateRow("AI Model", "M1", { ai_provider: "P1" });
    assert.equal(await loopar.db.getValue("AI Model", "ai_provider", "M1"), "P1");
  });
});

test("a soft-deleted record can't be connected to", async () => {
  await t.run(async () => {
    await loopar.db.deleteRow("AI Provider", "P2");           // soft delete (auditable)
    await rejects(
      () => loopar.db.insertRow("AI Model", { name: "M2", ai_provider: "P2" }),
      /The value P2 for ai_provider does not exist/
    );
  });
});

test("delete: refused while referenced, through the ORM and through the document", async () => {
  await t.run(async () => {
    await rejects(() => loopar.db.deleteRow("AI Provider", "P1"), /connected to:.*AI Model.*M1/s);
    await rejects(async () => (await loopar.getDocument("AI Provider", "P1")).delete(), /connected to:.*AI Model.*M1/s);
    assert.equal(await loopar.db.count("AI Provider", { name: "P1", __deleted_at__: null }), 1, "still there");
  });
});

test("delete: a reference from a single entity counts", async () => {
  await t.run(async () => {
    await loopar.db.insertRow("AI Model", { name: "M3", ai_provider: "P3" });
    await loopar.db.insertRow("AI", { ai_model: "M3" }, true);
    const found = await connectedDocuments(loopar.db, "AI Model", "M3");
    assert.deepEqual(found, [{ entity: "AI", name: "AI" }]);
    await rejects(() => loopar.db.deleteRow("AI Model", "M3"), /connected to:.*AI/s);
  });
});

test("delete: allowed once nothing points to the record; withoutReferenceChecks skips the check", async () => {
  await t.run(async () => {
    await loopar.db.insertRow("AI Model", { name: "M4", ai_provider: "P3" });
    await loopar.db.deleteRow("AI Model", "M4", { force: true });
    assert.equal(await loopar.db.count("AI Model", "M4"), 0);

    await withoutReferenceChecks(() => loopar.db.deleteRow("AI Provider", "P3", { force: true }));
    assert.equal(await loopar.db.count("AI Provider", "P3"), 0);
  });
});
