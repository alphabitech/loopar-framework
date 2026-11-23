import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { loopar } from "loopar";
import { bootTestTenant } from "../support/tenant.js";

/*
 * loopar.api(entity): what an entity exposes to other apps — the exports of
 * `<entity>.api.js` in its folder — found by the entity's name.
 */

let t;
before(async () => { t = await bootTestTenant({ apps: ["erp"] }); });
after(async () => { await t?.teardown(); });

test("an entity's api is reached by its name, whatever its app or module", async () => {
  await t.run(async () => {
    const { createCustomer, customerRow } = await loopar.api("Customer");
    const name = await createCustomer({ customer_name: "Acme", email: "ap@acme.test" });
    assert.equal((await customerRow(name, ["customer_name"])).customer_name, "Acme");

    // Names with spaces, and pages, resolve like any other entity.
    assert.equal(typeof (await loopar.api("Customer Address")).addressLine, "function");
    assert.equal(typeof (await loopar.api("ERP Reports")).profitAndLoss, "function");
    assert.equal(await loopar.api("Customer"), await loopar.api("Customer"), "the module is loaded once");
  });
});

test("an entity without an api, or one that is not in the workspace, answers 404", async () => {
  await t.run(async () => {
    await assert.rejects(() => loopar.api("Currency"), (e) => e.code === 404 && /exposes no api/.test(e.message));
    await assert.rejects(() => loopar.api("No Such Entity"), (e) => e.code === 404 && /not available/.test(e.message));
  });
});
