import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { loopar } from "loopar";
import { bootTestTenant } from "../support/tenant.js";
import { keepInstallersUntouched } from "../support/no-installer-writes.js";

/** Uploads are checked against their field on the server (Post.cover_image accepts image/*). */
let t;
before(async () => { t = await bootTestTenant(); await t.run(keepInstallersUntouched); });
after(async () => { await t?.teardown(); });

const upload = (originalname, mimetype, body) => ({ originalname, mimetype, size: Buffer.byteLength(body), buffer: Buffer.from(body) });

test("a file the field does not accept is refused before anything is written", async () => {
  await t.run(async () => {
    const post = await loopar.newDocument("Post", {
      name: "upload-check", title: "Upload check", app: "loopar",
      cover_image: JSON.stringify([{ name: "evil.html", size: 25, type: "text/html" }]),
      __REQ_FILES__: [upload("evil.html", "text/html", "<script>alert(1)</script>")],
    });
    await assert.rejects(() => post.save(), /not accepted/);
    assert.equal(await loopar.db.count("Post", { title: "Upload check" }), 0);
  });
});
