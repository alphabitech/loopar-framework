import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { loopar } from "loopar";
import { bootTestTenant } from "../support/tenant.js";
import { billingAccount, accountOf, stripeMode, stripeClientFor, verifyWebhook, keyMode } from "../../apps/loopar/modules/stripe/stripe-accounts.js";
import Stripe from "stripe";

/** Stripe Account: one record per mode, one of them the Billing account. */
const LIVE = "sk_live_" + "a".repeat(24);
const TEST = "sk_test_" + "b".repeat(24);
const account = async (data) => await loopar.newDocument("Stripe Account", data);

let t;
before(async () => { t = await bootTestTenant(); });
after(async () => { await t?.teardown(); });

test("keyMode() reads the mode from the key", () => {
  assert.equal(keyMode(LIVE), "live");
  assert.equal(keyMode("pk_test_abc"), "test");
  assert.equal(keyMode("••••••••"), null);
});

test("nothing configured: no billing account, test mode, no client", async () => {
  await t.run(async () => {
    assert.equal(await billingAccount(), null);
    assert.equal(await stripeMode(), "test");
    assert.equal(await stripeClientFor("live"), null);
  });
});

test("the mode comes from the Secret Key and the first account bills", async () => {
  await t.run(async () => {
    await assert.rejects((await account({ name: "Nokey" })).save(), /Secret Key/);
    await assert.rejects((await account({ name: "Mixed", secret_key: TEST, publishable_key: "pk_live_x" })).save(), /same Stripe mode/);

    await (await account({ name: "Test", secret_key: TEST, webhook_secret: "whsec_test" })).save();

    const billing = await billingAccount();
    assert.equal(billing.name, "Test");
    assert.equal(billing.mode, "test");
    assert.equal(billing.secret_key, TEST, "the secret is readable server side");
    const stored = await loopar.db.qx()("Stripe Account").where({ name: "Test" }).first();
    assert.notEqual(stored.secret_key, TEST, "and encrypted at rest");
  });
});

test("one account per mode; marking another as Billing moves the mark", async () => {
  await t.run(async () => {
    await assert.rejects((await account({ name: "Test 2", secret_key: TEST })).save(), /one account per mode/);

    await (await account({ name: "Live", secret_key: LIVE, webhook_secret: "whsec_live" })).save();
    assert.equal((await billingAccount()).name, "Test", "a second account does not take billing over");
    assert.equal((await accountOf("live")).name, "Live");
    assert.ok(await stripeClientFor("live"));

    const live = await loopar.getDocument("Stripe Account", "Live");
    live.billing = 1;
    await live.save();

    assert.equal((await billingAccount()).name, "Live");
    assert.equal(await stripeMode(), "live");
    const rows = await loopar.db.getAll("Stripe Account", ["name", "billing"]);
    assert.equal(rows.filter(r => Number(r.billing) === 1).length, 1);
  });
});

test("the Billing account can't be deleted while others exist", async () => {
  await t.run(async () => {
    await assert.rejects((await loopar.getDocument("Stripe Account", "Live")).delete(), /Billing account/);
  });
});

test("verifyWebhook() tells which account signed a delivery", async () => {
  await t.run(async () => {
    const payload = JSON.stringify({ id: "evt_1", object: "event", type: "ping" });
    const sign = (secret) => Stripe.webhooks.generateTestHeaderString({ payload, secret });

    const live = await verifyWebhook(payload, sign("whsec_live"));
    assert.equal(live.account.name, "Live");
    assert.equal(live.billing, true);

    const other = await verifyWebhook(payload, sign("whsec_test"));
    assert.equal(other.account.name, "Test");
    assert.equal(other.billing, false);

    assert.equal(await verifyWebhook(payload, sign("whsec_unknown")), null);
  });
});
