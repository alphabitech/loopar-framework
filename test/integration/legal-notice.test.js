import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { loopar } from "loopar";
import { bootTestTenant } from "../support/tenant.js";
import { keepInstallersUntouched } from "../support/no-installer-writes.js";

/** Legal Notice (web module): one address per app, dates kept by the model. */
let t;
before(async () => { t = await bootTestTenant(); await t.run(keepInstallersUntouched); });
after(async () => { await t?.teardown(); });

const notice = (data) => loopar.newDocument("Legal Notice", { app: "loopar", ...data });

test("the slug comes from the title and is unique per app", async () => {
  await t.run(async () => {
    const a = await notice({ title: "Privacy Notice", description: "Text A" });
    await a.save();
    assert.equal(a.slug, "privacy-notice");
    assert.ok(a.last_updated, "last updated is set");

    const b = await notice({ title: "Privacy Notice", description: "Text B" });
    await b.save();
    assert.equal(b.slug, "privacy-notice-2", "a generated slug avoids the taken one");

    const c = await notice({ title: "Other", slug: "privacy-notice", description: "Text C" });
    await assert.rejects(() => c.save(), /already uses the address/);
  });
});

test("publishing sets the effective date", async () => {
  await t.run(async () => {
    const n = await notice({ title: "Terms of Use", description: "Terms", published: 1 });
    await n.save();
    assert.ok(n.effective_date);
  });
});
