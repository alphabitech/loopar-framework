import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { loopar } from "loopar";
import { bootTestTenant } from "../support/tenant.js";
import { keepInstallersUntouched } from "../support/no-installer-writes.js";
import { mayReadPrivateFile, purgePrivateFiles } from "loopar/core/global/private-files.js";

/** Private files follow the record they belong to (see private-files.js). */
let t;
before(async () => { t = await bootTestTenant(); await t.run(keepInstallersUntouched); });
after(async () => { await t?.teardown(); });

/** A private file on disk with its sidecar, owned by `owner`. */
function privateFile(name, owner) {
  const dir = loopar.getAssetPath({ visibility: "private" });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), "%PDF-1.4");
  const meta = { name, storage_driver: "local", src: `/assets/private/${name}`, visibility: "private", owner };
  fs.writeFileSync(path.join(dir, `${name}.meta.json`), JSON.stringify(meta));
  return { meta, file: path.join(dir, name) };
}

test("access follows the record: live, soft-deleted (Administrator only), gone", async () => {
  await t.run(async () => {
    const post = `pf-${Date.now()}`;
    await (await loopar.newDocument("Post", { name: post, title: post, app: "loopar" })).save();
    const { meta } = privateFile("aaaaaaaaaaaaaaaaaaaaaaaa-cv.pdf", { entity: "Post", name: post, field: "x" });

    assert.equal(await mayReadPrivateFile(meta, "Administrator"), true);
    assert.equal(await mayReadPrivateFile(meta, "someone-without-roles"), false, "no permission on the record");

    await loopar.deleteDocument("Post", post);                 // soft delete
    assert.equal(await mayReadPrivateFile(meta, "Administrator"), true, "the Administrator audits deleted records");

    await loopar.db.deleteRow("Post", post, { force: true });   // purged
    assert.equal(await mayReadPrivateFile(meta, "Administrator"), false, "no record, no file");
  });
});

test("deleting for good removes every private file of the record", async () => {
  await t.run(async () => {
    const a = privateFile("bbbbbbbbbbbbbbbbbbbbbbbb-a.pdf", { entity: "Post", name: "gone", field: "x" });
    const b = privateFile("cccccccccccccccccccccccc-b.pdf", { entity: "Post", name: "gone", field: "x" });
    const other = privateFile("dddddddddddddddddddddddd-c.pdf", { entity: "Post", name: "kept", field: "x" });

    await purgePrivateFiles("Post", "gone");
    assert.equal(fs.existsSync(a.file), false);
    assert.equal(fs.existsSync(`${b.file}.meta.json`), false);
    assert.equal(fs.existsSync(other.file), true, "another record's file stays");
  });
});
