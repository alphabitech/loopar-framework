import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loopar } from "loopar";
import { bootTestTenant } from "../support/tenant.js";

/**
 * An app update removes the structure the app no longer ships: entities,
 * builder documents and modules of the app that are neither in its
 * installer.json nor on disk. What it still ships, and other apps'
 * structure, stays.
 */
let t;
const root = process.cwd();

before(async () => { t = await bootTestTenant({ apps: ["erp", "gym"] }); });
after(async () => { await t?.teardown(); });

const exists = (entity, name) => loopar.db.count(entity, { name });

test("an update removes entities, pages and modules the app no longer ships", async () => {
  await t.run(async () => {
    const q = () => loopar.db.qx();
    // What an older version of gym left in the tenant (no files, not in installer.json).
    await q()("Module").insert({ name: "gym-legacy", app_name: "gym", description: "Legacy", __document_status__: 1 });
    await q()("Entity").insert({ name: "Gym Old Charge", module: "gym-desk", doc_structure: "[]", __document_status__: 1 });
    await q()("Entity").insert({ name: "Gym Old Sale", module: "gym-legacy", doc_structure: "[]", __document_status__: 1 });
    await q()("Page Builder").insert({ name: "Gym Old POS", module: "gym-legacy", doc_structure: "[]", __document_status__: 1 });
    // Another app's structure is never touched.
    await q()("Entity").insert({ name: "Erp Leftover", module: "billing", doc_structure: "[]", __document_status__: 1 });

    const { default: Installer } = await import(path.join(root, "apps", "gym", "installer.js"));
    await new Installer({ app_name: "gym" }).install(true);

    assert.equal(await exists("Entity", "Gym Old Charge"), 0);
    assert.equal(await exists("Entity", "Gym Old Sale"), 0);
    assert.equal(await exists("Page Builder", "Gym Old POS"), 0);
    assert.equal(await exists("Module", "gym-legacy"), 0, "an emptied module the app no longer ships goes too");

    for (const name of ["Gym Member", "Gym Membership", "Gym Membership Period", "Gym Plan"]) {
      assert.equal(await exists("Entity", name), 1, `${name} stays`);
    }
    assert.equal(await exists("Page Builder", "Gym Front Desk"), 1);
    assert.equal(await exists("Module", "gym-desk"), 1);
    assert.equal(await exists("Entity", "Erp Leftover"), 1, "other apps' records stay");
  });
});

test("a fresh install removes nothing; a second update is a no-op", async () => {
  await t.run(async () => {
    const { default: Installer } = await import(path.join(root, "apps", "gym", "installer.js"));
    const model = new Installer({ app_name: "gym" });
    const { fileManage } = await import("loopar");
    const appData = await fileManage.getConfigFile("installer", loopar.makePath("apps", "gym"));
    assert.deepEqual(await model.pruneRemoved(appData), []);
  });
});
