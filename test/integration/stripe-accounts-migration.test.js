import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { loopar } from "loopar";
import { bootTestTenant } from "../support/tenant.js";
import { keepInstallersUntouched } from "../support/no-installer-writes.js";
import Installer from "../../apps/loopar/installer.js";
import { billingAccount, accountOf } from "../../apps/loopar/modules/stripe/stripe-accounts.js";

/**
 * 7.5.15: the two Stripe singles (loopar's `Stripe`, control's `Stripe
 * Account`) become Stripe Account records, one per mode.
 */
const SINGLES = "Document Single Values";
const LIVE = "sk_live_" + "a".repeat(24);
const TEST = "sk_test_" + "b".repeat(24);
const OLD_TEST = "sk_test_" + "c".repeat(24);

let t;
before(async () => {
  t = await bootTestTenant();
  await t.run(keepInstallersUntouched);
  await t.run(async () => {
    const q = () => loopar.db.qx();
    const put = async (document, field, value) =>
      await q()(SINGLES).insert({ name: `${document}-${field}`, document, field, value });

    await put("Stripe Account", "name", "Cloud billing");
    await put("Stripe Account", "mode", "live");
    await put("Stripe Account", "publishable_key", "pk_live_cloud");
    await put("Stripe Account", "secret_key", loopar.encryptSecret(LIVE));
    await put("Stripe Account", "webhook_secret", loopar.encryptSecret("whsec_cloud"));
    await put("Stripe Account", "test_secret_key", loopar.encryptSecret(TEST));
    // The old loopar single: its test key loses to the control one.
    await put("Stripe", "public_key", loopar.encryptSecret("pk_test_old"));
    await put("Stripe", "secret_key", loopar.encryptSecret(OLD_TEST));

    const [entity] = await q()("Entity").where({ name: "Stripe Account" });
    const { id, ...row } = entity;
    await q()("Entity").insert({ ...row, name: "Stripe", is_single: 1 });

    await new Installer({ app_name: "loopar" }).install(true);
  });
});
after(async () => { await t?.teardown(); });

test("the control account becomes the Billing account, with its secrets", async () => {
  await t.run(async () => {
    const billing = await billingAccount();
    assert.equal(billing.name, "live");
    assert.equal(billing.mode, "live");
    assert.equal(billing.secret_key, LIVE);
    assert.equal(billing.webhook_secret, "whsec_cloud");
    assert.equal(billing.publishable_key, "pk_live_cloud");
  });
});

test("its test key becomes the test account (not billing)", async () => {
  await t.run(async () => {
    const testAccount = await accountOf("test");
    assert.equal(testAccount.secret_key, TEST);
    assert.equal(Number(testAccount.billing), 0);
    assert.equal(await loopar.db.count("Stripe Account", {}), 2);
  });
});

test("the old values and the Stripe single are gone; the stripe module hangs from Integrations", async () => {
  await t.run(async () => {
    const q = () => loopar.db.qx();
    assert.equal((await q()(SINGLES).whereIn("document", ["Stripe Account", "Stripe"])).length, 0);
    assert.equal((await q()("Entity").where({ name: "Stripe" })).length, 0);

    const [module] = await q()("Module").where({ name: "stripe" });
    assert.equal(module.parent_module, "Integrations");
    assert.equal(module.app_name, "loopar");
  });
});

test("running the update again changes nothing", async () => {
  await t.run(async () => {
    await new Installer({ app_name: "loopar" }).install(true);
    assert.equal(await loopar.db.count("Stripe Account", {}), 2);
    assert.equal((await billingAccount()).name, "live");
  });
});
