import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loopar, DOC_STATUS, AMENDED_FROM_COLUMN } from "loopar";
import { bootTestTenant } from "../support/tenant.js";
import { keepInstallersUntouched } from "../support/no-installer-writes.js";
import { integrityReport, fixEmptyConnections } from "../../packages/loopar/core/document/integrity-report.js";
import { desiredForeignKeys, fkName } from "../../packages/loopar/core/document/foreign-keys.js";
import { resetIntegrityModeCache } from "../../packages/loopar/core/global/integrity-mode.js";
import { withLifecycle } from "../../packages/loopar/core/document/document-lifecycle.js";

/**
 * ORM integrity rules beyond links (empty → NULL, immutable name, deleteWhere,
 * Role cleanup, warn mode), the integrity report, the foreign keys the refs
 * declare, and the submittable lifecycle (Draft → Submitted → Cancelled →
 * amended). Entities are made submittable at runtime by flagging their ref.
 */
let t;
before(async () => {
  t = await bootTestTenant();
  await t.run(async () => {
    // Saving installer records (Role, Letterhead…) must not rewrite apps/*/installer.json.
    await keepInstallersUntouched();
    for (const name of ["P1", "P2"]) await loopar.db.insertRow("AI Provider", { name, api_key: "k" });
    await loopar.db.insertRow("AI Model", { name: "M1", ai_provider: "P1" });
  });
});
after(async () => { await t?.teardown(); });

const rejects = (fn, re) => assert.rejects(fn, (e) => re.test(String(e?.message ?? e)));
const status = (entity, name) => loopar.db.qx()(entity).where({ name }).first("__document_status__").then((r) => Number(r?.__document_status__));

test("an empty connection is stored as NULL", async () => {
  await t.run(async () => {
    await loopar.db.insertRow("AI Model", { name: "M-empty", ai_provider: "" });
    const row = await loopar.db.qx()("AI Model").where({ name: "M-empty" }).first("ai_provider");
    assert.equal(row.ai_provider, null);
  });
});

test("a record's name can't change through an update", async () => {
  await t.run(async () => {
    await rejects(() => loopar.db.updateRow("AI Model", "M1", { name: "M1-renamed" }), /can't be changed/);
    await loopar.db.updateRow("AI Model", "M1", { name: "M1" }); // same name: fine
  });
});

test("deleteWhere checks every matching row, not only the first", async () => {
  await t.run(async () => {
    await loopar.db.insertRow("AI Provider", { name: "P-free", api_key: "k" });
    // P-free is free, P1 is referenced by M1: the whole delete is refused.
    await rejects(
      () => loopar.db.withTransaction(async () => {
        await loopar.db.deleteWhere("AI Provider", { name: "P-free" });
        await loopar.db.deleteWhere("AI Provider", { name: "P1" });
      }),
      /connected to/
    );
    assert.equal(await loopar.db.count("AI Provider", "P-free"), 1, "rolled back with the refused row");
  });
});

test("deleting a Role deletes its grants", async () => {
  await t.run(async () => {
    await loopar.db.insertRow("Role", { name: "Temp Role", app: "loopar" });
    await loopar.db.insertRow("Permission", { name: "perm-temp", relation: "Role", relation_name: "Temp Role", document: "AI Model", action: "view" });
    await (await loopar.getDocument("Role", "Temp Role")).delete({ sofDelete: false });
    assert.equal(await loopar.db.qx()("Permission").where({ name: "perm-temp" }).first("id"), undefined);
  });
});

test("the integrity report lists orphans and empty connections; --fix-empty clears them", async () => {
  await t.run(async () => {
    // Written behind the ORM's back, like old data.
    await loopar.db.qx()("AI Model").insert({ name: "M-orphan", ai_provider: "Ghost" });
    await loopar.db.qx()("AI Model").insert({ name: "M-blank", ai_provider: "" });

    const report = await integrityReport();
    const orphan = report.orphans.find((o) => o.entity === "AI Model" && o.field === "ai_provider");
    assert.ok(orphan, "orphan listed");
    assert.ok(orphan.sample.some((s) => s.name === "M-orphan" && s.value === "Ghost"));
    assert.ok(report.empty.some((e) => e.entity === "AI Model" && e.field === "ai_provider"));

    assert.ok(await fixEmptyConnections() >= 1);
    const after = await integrityReport();
    assert.ok(!after.empty.some((e) => e.entity === "AI Model"));
    await loopar.db.qx()("AI Model").whereIn("name", ["M-orphan", "M-blank"]).delete();
  });
});

test("warn mode logs what strict mode refuses", async () => {
  const config = path.join(process.cwd(), "sites", t.name, "config.json");
  const original = fs.readFileSync(config, "utf8");
  try {
    fs.writeFileSync(config, JSON.stringify({ ...JSON.parse(original), integrity: "warn" }));
    resetIntegrityModeCache();
    await t.run(async () => {
      await loopar.db.insertRow("AI Model", { name: "M-warn", ai_provider: "Nope" });
      assert.equal(await loopar.db.count("AI Model", "M-warn"), 1, "written, only logged");
      await loopar.db.qx()("AI Model").where({ name: "M-warn" }).delete();
    });
  } finally {
    fs.writeFileSync(config, original);
    resetIntegrityModeCache();
  }
});

test("foreign keys: simple connections and single-parent children, never structure records", async () => {
  await t.run(async () => {
    const fks = desiredForeignKeys();
    assert.ok(fks.some((k) => k.table === "AI Model" && k.column === "ai_provider" && k.refTable === "AI Provider" && k.refColumn === "name"));
    assert.ok(!fks.some((k) => k.kind === "link" && ["Entity", "Module", "App"].includes(k.refTable)), "no link keys to structure records");
    assert.ok(!fks.some((k) => k.table === "Event" && k.column === "assigned_to"), "no key on a multiple connection");
    assert.ok(fks.every((k) => k.name.length <= 60 && k.name.startsWith("fk_")));
    assert.equal(fkName("AI Model", "ai_provider"), fkName("AI Model", "ai_provider"), "deterministic");
  });
});

// ── Submittable lifecycle ────────────────────────────────────────────────────
const makeSubmittable = (entity, allowOnSubmit = []) => {
  const ref = loopar.getRef(entity);
  ref.is_submittable = 1;
  for (const f of allowOnSubmit) ref.__FIELD_META__[f] = { ...ref.__FIELD_META__[f], allow_on_submit: 1 };
};

test("lifecycle: draft, submit, locked fields, cancel, amend", async () => {
  await t.run(async () => {
    makeSubmittable("Letterhead", ["is_default"]);
    await (await loopar.newDocument("Letterhead", { name: "LH-1", tagline: "First" })).save();
    assert.equal(await status("Letterhead", "LH-1"), DOC_STATUS.DRAFT, "a new record is a Draft");

    // Status only through the steps.
    await rejects(() => loopar.db.updateRow("Letterhead", "LH-1", { __document_status__: DOC_STATUS.SUBMITTED }), /only through Submit/);

    const doc = await loopar.getDocument("Letterhead", "LH-1");
    await doc.submit();
    assert.equal(await status("Letterhead", "LH-1"), DOC_STATUS.SUBMITTED);

    await rejects(() => loopar.db.updateRow("Letterhead", "LH-1", { tagline: "Changed" }), /Submitted: tagline can't be changed/);
    await loopar.db.updateRow("Letterhead", "LH-1", { is_default: 1 }); // allow_on_submit
    // setValue goes through the same checks, row by row.
    await rejects(() => loopar.db.setValue("Letterhead", "tagline", "Changed", "LH-1"), /Submitted: tagline can't be changed/);
    await rejects(() => loopar.db.setValue("Letterhead", "tagline", "Bulk", { tagline: "First" }), /Submitted/);
    await loopar.db.setValue("Letterhead", "is_default", 0, "LH-1");
    await loopar.db.setValue("Letterhead", "is_default", 1, "LH-1");
    assert.equal(Number(await loopar.db.getValue("Letterhead", "is_default", "LH-1")), 1, "allow_on_submit fields take setValue");
    await rejects(async () => (await loopar.getDocument("Letterhead", "LH-1")).delete(), /can't be deleted/);
    await rejects(async () => (await loopar.getDocument("Letterhead", "LH-1")).submit(), /only a Draft/);

    await (await loopar.getDocument("Letterhead", "LH-1")).cancel();
    assert.equal(await status("Letterhead", "LH-1"), DOC_STATUS.CANCELLED);
    await rejects(() => loopar.db.updateRow("Letterhead", "LH-1", { is_default: 0 }), /Cancelled/);
    await rejects(() => loopar.db.deleteRow("Letterhead", "LH-1", { force: true }), /can't be deleted/);

    // Submit and cancel on one instance: setStatus syncs its version.
    await (await loopar.newDocument("Letterhead", { name: "LH-2", tagline: "Same instance" })).save();
    const same = await loopar.getDocument("Letterhead", "LH-2");
    await same.submit();
    await same.cancel();
    assert.equal(await status("Letterhead", "LH-2"), DOC_STATUS.CANCELLED);

    const amended = await (await loopar.getDocument("Letterhead", "LH-1")).amend();
    assert.equal(amended.name, "LH-1-1");
    const row = await loopar.db.qx()("Letterhead").where({ name: "LH-1-1" }).first();
    assert.equal(Number(row.__document_status__), DOC_STATUS.DRAFT);
    assert.equal(row[AMENDED_FROM_COLUMN], "LH-1");
    assert.equal(row.tagline, "First", "copied");

    // An amendment of an amendment continues the numbering.
    await (await loopar.getDocument("Letterhead", "LH-1-1")).submit();
    await (await loopar.getDocument("Letterhead", "LH-1-1")).cancel();
    assert.equal((await (await loopar.getDocument("Letterhead", "LH-1-1")).amend()).name, "LH-1-2");

    // A draft is deleted freely.
    await (await loopar.getDocument("Letterhead", "LH-1-2")).delete({ sofDelete: false });
    assert.equal(await loopar.db.count("Letterhead", "LH-1-2"), 0);
  });
});

test("lifecycle: links between submittable records", async () => {
  await t.run(async () => {
    makeSubmittable("AI Provider");
    makeSubmittable("AI Model");
    await withLifecycle(() => loopar.db.updateRow("AI Provider", "P2", { __document_status__: DOC_STATUS.DRAFT }));
    await loopar.db.insertRow("AI Model", { name: "M2", ai_provider: "P2" });

    // A submitted record can't point to a draft.
    await rejects(async () => (await loopar.getDocument("AI Model", "M2")).submit(), /AI Provider P2 is Draft; it must be submitted first/);

    await (await loopar.getDocument("AI Provider", "P2")).submit();
    await (await loopar.getDocument("AI Model", "M2")).submit();

    // P2 can't be cancelled while a submitted M2 points to it.
    await rejects(async () => (await loopar.getDocument("AI Provider", "P2")).cancel(), /cancel them first/);
    await (await loopar.getDocument("AI Model", "M2")).cancel();
    await (await loopar.getDocument("AI Provider", "P2")).cancel();
    assert.equal(await status("AI Provider", "P2"), DOC_STATUS.CANCELLED);
  });
});
