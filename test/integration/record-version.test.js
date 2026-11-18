import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { loopar } from "loopar";
import { bootTestTenant } from "../support/tenant.js";

/**
 * Optimistic concurrency: a save applies only over the `__version__` it was
 * read from. Uses Letterhead (a plain auditable entity).
 */
const E = "Letterhead";
let t;
let serial = 0;

const version = (name) => loopar.db.rowVersion(E, name);
const row = (name) => loopar.db.qx()(E).where({ name }).first();
async function create() {
  const name = `LH ${++serial}`;
  await (await loopar.newDocument(E, { name, tagline: "first" })).save();
  return name;
}
const stale = (run) => assert.rejects(run, (e) => /was changed after it was opened/.test(e.message) && Number(e.code) === 409);

before(async () => { t = await bootTestTenant(); });
after(async () => { await t?.teardown(); });

test("a record starts at 0 and every save adds one; an instance can keep saving", async () => {
  await t.run(async () => {
    const name = await create();
    assert.equal(await version(name), 0);

    const doc = await loopar.getDocument(E, name);
    doc.tagline = "second";
    await doc.save();
    assert.equal(await version(name), 1);
    doc.tagline = "third";
    await doc.save();
    assert.equal(await version(name), 2);
    assert.equal((await row(name)).tagline, "third");
    assert.deepEqual(doc.versionStamp(), { __version__: 2 });
  });
});

test("of two documents read from the same version only the first save lands", async () => {
  await t.run(async () => {
    const name = await create();
    const slow = await loopar.getDocument(E, name);   // e.g. busy sending an email
    const quick = await loopar.getDocument(E, name);

    quick.tagline = "quick";
    await quick.save();
    slow.tagline = "slow";
    slow.footer = "written over stale data";
    await stale(() => slow.save());

    const r = await row(name);
    assert.equal(r.tagline, "quick");
    assert.notEqual(r.footer, "written over stale data");
    assert.equal(await version(name), 1);
  });
});

test("a form saves over the version it was loaded with", async () => {
  await t.run(async () => {
    const name = await create();
    const opened = (await loopar.getDocument(E, name)).versionStamp().__version__;

    // Someone else saves while the form is open.
    const other = await loopar.getDocument(E, name);
    other.tagline = "theirs";
    await other.save();

    // The form posts its fields plus the version it holds (as form data: a string).
    await stale(async () => (await loopar.getDocument(E, name, { tagline: "mine", __version__: String(opened) })).save());
    assert.equal((await row(name)).tagline, "theirs");

    // Reloaded, the same edit goes through.
    const reloaded = (await loopar.getDocument(E, name)).versionStamp().__version__;
    await (await loopar.getDocument(E, name, { tagline: "mine", __version__: String(reloaded) })).save();
    assert.equal((await row(name)).tagline, "mine");
  });
});

test("a direct write counts: syncVersion or overwrite for code that knows", async () => {
  await t.run(async () => {
    const name = await create();
    const doc = await loopar.getDocument(E, name);

    await loopar.db.setValue(E, "footer", "direct", name);
    assert.equal(await version(name), 1);
    doc.tagline = "after a direct write";
    await stale(() => doc.save());

    await doc.syncVersion();
    await doc.save();
    assert.equal((await row(name)).tagline, "after a direct write");

    const behind = await loopar.getDocument(E, name);
    await loopar.db.setValue(E, "footer", "again", name);
    behind.tagline = "forced";
    await behind.save({ overwrite: true });
    assert.equal((await row(name)).tagline, "forced");
  });
});

test("a table from before the column gets it on the next schema sync, rows at 0", async () => {
  await t.run(async () => {
    const name = await create();
    await loopar.db.qx().raw('alter table "Letterhead" drop column "__version__"');
    loopar.db.invalidateColumnsCache(E);

    // Not migrated yet: saves work, unchecked.
    const doc = await loopar.getDocument(E, name);
    assert.deepEqual(doc.versionStamp(), {});
    doc.tagline = "unversioned";
    await doc.save();
    assert.equal(await version(name), null);

    const ref = loopar.getRef(E);
    await loopar.db.makeTable(E, ref.__FIELDS_STRUCTURE__ || ref.doc_structure || []);
    loopar.db.invalidateColumnsCache(E);
    assert.equal(await version(name), 0);
    const migrated = await loopar.getDocument(E, name);
    migrated.tagline = "versioned";
    await migrated.save();
    assert.equal(await version(name), 1);
  });
});
