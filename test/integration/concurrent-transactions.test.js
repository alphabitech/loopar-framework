import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { loopar } from "loopar";
import { bootTestTenant } from "../support/tenant.js";

/*
 * Two async flows of the same request (e.g. a background email delivery and
 * the action that queued it) each save documents: each save's transaction
 * belongs to the flow that opened it, so one never runs its queries inside —
 * or after the end of — the other's ("Transaction query already complete").
 */

let t;
before(async () => { t = await bootTestTenant(); });
after(async () => { await t?.teardown(); });

const saves = async (prefix, n) => {
  for (let i = 0; i < n; i++) {
    const doc = await loopar.newDocument("Letterhead", { name: `${prefix}-${i}`, tagline: prefix });
    await doc.save();
    // A read right after, while the other flow may be inside its transaction.
    assert.equal(await loopar.db.getValue("Letterhead", "tagline", `${prefix}-${i}`), prefix);
    await new Promise((r) => setImmediate(r));
  }
};

test("concurrent flows of one request keep their transactions apart", async () => {
  await t.run(async () => {
    await Promise.all([saves("flow-a", 15), saves("flow-b", 15), loopar.db.detached(() => saves("flow-c", 15))]);
    assert.equal(await loopar.db.count("Letterhead", { tagline: "flow-a" }), 15);
    assert.equal(await loopar.db.count("Letterhead", { tagline: "flow-b" }), 15);
    assert.equal(await loopar.db.count("Letterhead", { tagline: "flow-c" }), 15);
    assert.equal(loopar.db.transaction, null, "nothing left open");
  });
});

test("a background email delivery runs beside the request's own saves", async () => {
  await t.run(async () => {
    const settings = await loopar.getDocument("Email Settings");
    Object.assign(settings, { host: "smtp.test", port: 465, secure: 1, from_name: "T", from_email: "t@loopar.test" });
    await settings.save();
    loopar.mail.getTransporter = async () => ({ sendMail: async () => { await new Promise((r) => setTimeout(r, 5)); return { messageId: "m1" }; } });

    const { delivery } = await loopar.mail.sendLater({ to: "x@example.test", subject: "Hi", html: "<p>hi</p>" });
    await saves("during-delivery", 10);
    const result = await delivery;
    assert.equal(result.success, true);
  });
});
