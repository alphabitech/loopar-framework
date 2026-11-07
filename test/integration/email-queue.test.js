import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { loopar } from "loopar";
import { bootTestTenant } from "../support/tenant.js";

/*
 * Email Queue queries use the current condition format (plain fields + Op
 * symbols). The old string operators ({ '=': {...}, 'OR': [...] }) failed with
 * "no such column: =".
 */

let t;
before(async () => { t = await bootTestTenant(); });
after(async () => { await t?.teardown(); });

const sent = [];
async function stubTransport() {
  await t.run(async () => {
    const settings = await loopar.getDocument("Email Settings");
    Object.assign(settings, { host: "smtp.test", port: 465, secure: 1, from_name: "T", from_email: "t@loopar.test" });
    await settings.save();
    loopar.mail.getTransporter = async () => ({
      sendMail: async (opts) => { sent.push(opts); return { messageId: `m${sent.length}` }; },
    });
  });
}

const status = (name) => loopar.db.getValue("Email Queue", "status", name);

test("processQueue sends what is due, by priority, and leaves the future alone", async () => {
  await stubTransport();
  await t.run(async () => {
    const future = new Date(Date.now() + 3600e3).toISOString();
    const past = new Date(Date.now() - 60e3).toISOString();
    const q = async (o) => (await loopar.mail.queue({ to: "a@x.test", subject: o.subject, html: "<p>x</p>", ...o })).queueId;

    const low = await q({ subject: "low", priority: "Low" });
    const urgent = await q({ subject: "urgent", priority: "Urgent" });
    const later = await q({ subject: "later", scheduledAt: future });
    const due = await q({ subject: "due", scheduledAt: past });
    for (const id of [low, urgent, later, due]) assert.ok(id, "queued");

    const r = await loopar.mail.processQueue(2);
    assert.equal(r.success, true, r.error);
    assert.equal(r.processed, 2, "limit honored");
    assert.deepEqual(sent.map((m) => m.subject), ["urgent", "due"], "Urgent first; Normal before Low");

    const r2 = await loopar.mail.processQueue();
    assert.equal(r2.processed, 1);
    assert.equal(await status(low), "Sent");
    assert.equal(await status(later), "Pending", "scheduled in the future");
  });
});

test("retryFailed and cleanOldEmails", async () => {
  await t.run(async () => {
    const { queueId } = await loopar.mail.queue({ to: "b@x.test", subject: "f", html: "x" });
    await loopar.db.setValue("Email Queue", "status", "Failed", queueId);

    const r = await loopar.mail.retryFailed([queueId]);
    assert.equal(r.updated, 1);
    assert.equal(await status(queueId), "Pending");

    // Backdate one sent email: only that one is old enough to clean.
    const oldOne = (await loopar.db.getAll("Email Queue", ["name"], { status: "Sent" }))[0].name;
    await loopar.db.setValue("Email Queue", "__created_at__", "2020-01-01 00:00:00", oldOne);
    const c = await loopar.mail.cleanOldEmails(30);
    assert.equal(c.deleted, 1);
    assert.equal((await loopar.mail.getQueueStats()).sent, 2);
  });
});
