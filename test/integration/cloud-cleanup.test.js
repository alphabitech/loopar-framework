import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { loopar } from "loopar";
import { bootTestTenant } from "../support/tenant.js";

/*
 * Canceled workspaces are deleted only Cloud Settings' days after Stripe ended
 * them. Rows without an end date are never deleted. The removal itself is
 * replaced by a recorder: nothing on disk is touched.
 */

let t, lifecycle;
const destroyed = [];
const DAY = 864e5;
// Records instead of tearing anything down.
const removeTenant = async (name) => { destroyed.push(name); return true; };

before(async () => {
  t = await bootTestTenant();
  await t.run(async () => {
    const { default: Installer } = await import(`${process.cwd()}/apps/control/installer.js`);
    await new Installer({ app_name: "control" }).install();
  });
  lifecycle = await import(`${process.cwd()}/apps/control/modules/subscriptions/lifecycle.js`);
});
after(async () => { await t?.teardown(); });

const iso = (ms) => new Date(ms).toISOString();
const sub = (name, fields) => loopar.db.insertRow("Subscription", { name, tenant_name: `ws-${name}`, ...fields });

test("Cloud Settings defaults to 5 days and validates", async () => {
  await t.run(async () => {
    assert.deepEqual(await lifecycle.cloudSettings(), { graceDays: 5, autoDelete: true });
    const s = await loopar.getDocument("Cloud Settings");
    s.deletion_grace_days = 0;
    await assert.rejects(() => s.save(), /at least 1/);
  });
});

test("deletes only what ended more than the grace period ago", async () => {
  const now = Date.now();
  await t.run(async () => {
    await sub("old", { status: "canceled", canceled_at: iso(now - 30 * DAY), ended_at: iso(now - 6 * DAY) });
    // Cancel at period end: requested long ago, ended yesterday → not yet.
    await sub("period-end", { status: "canceled", canceled_at: iso(now - 40 * DAY), ended_at: iso(now - 1 * DAY) });
    await sub("no-date", { status: "canceled" });
    await sub("active", { status: "active", canceled_at: iso(now - 30 * DAY) });

    const removed = await lifecycle.cleanupCanceledTenants({ now, removeTenant });
    assert.deepEqual(destroyed, ["ws-old"]);
    assert.equal(removed, 1);

    const planned = await loopar.db.getValue("Subscription", "delete_after", "period-end");
    assert.equal(new Date(planned).getTime(), now - 1 * DAY + 5 * DAY, "planned date shown");
    assert.equal(await loopar.db.getValue("Subscription", "provisioning_step", "old"), "deleted");

    // Runs again: the deleted one is not retried.
    destroyed.length = 0;
    await lifecycle.cleanupCanceledTenants({ now, removeTenant });
    assert.deepEqual(destroyed, []);
  });
});

test("a longer grace period or the switch off holds deletions", async () => {
  const now = Date.now();
  await t.run(async () => {
    const s = await loopar.getDocument("Cloud Settings");
    s.deletion_grace_days = 10;
    s.auto_delete_canceled = 1;
    await s.save();
    await sub("eight", { status: "canceled", ended_at: iso(now - 8 * DAY) });
    await lifecycle.cleanupCanceledTenants({ now, removeTenant });
    assert.deepEqual(destroyed, [], "8 < 10 days");

    s.deletion_grace_days = 3;
    s.auto_delete_canceled = 0;
    await s.save();
    await lifecycle.cleanupCanceledTenants({ now, removeTenant });
    assert.deepEqual(destroyed, [], "switch off");

    s.auto_delete_canceled = 1;
    await s.save();
    await lifecycle.cleanupCanceledTenants({ now, removeTenant });
    assert.deepEqual(destroyed, ["ws-eight"]);
  });
});
