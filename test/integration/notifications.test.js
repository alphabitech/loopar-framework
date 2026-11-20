import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { loopar, requestContext, applyTransition } from "loopar";
import { bootTestTenant } from "../support/tenant.js";

/*
 * Realtime + in-app notifications:
 *   - a record's write is announced in its own room (doc:<Entity>/<name>);
 *   - a workflow transition or a comment made by someone else notifies the
 *     record's owner (a Notification row + `user:<owner>` notification event);
 *   - a transition and its comment in the same moment join one notification;
 *   - each user reads and marks only their own.
 */

let t;
const OWNER = "owner@x.test";
before(async () => {
  t = await bootTestTenant({ apps: ["erp"] });
  await t.run(async () => {
    for (const name of [OWNER, "other@x.test"]) {
      const u = await loopar.newDocument("User", { name, email: name, password: "Aa1!aaaaaaaa", confirm_password: "Aa1!aaaaaaaa", user_type: "Desk", __document_status__: "Active" });
      await u.save({ validate: false });
    }
  });
});
after(async () => { await t?.teardown(); });

/** Runs `fn` in tenant `t` as `user` (null = nobody: a public link, a job). */
const as = (user, fn) => t.run(() => requestContext.run({ ...requestContext.getStore(), req: { __authUserName__: user, headers: {}, cookies: {} } }, fn));
const q = () => loopar.db.qx();

/** Records the realtime events emitted while `fn` runs (at the socket layer). */
async function capture(fn) {
  const { RealtimeManager } = await import(`${process.cwd()}/packages/loopar/core/realtime/RealtimeManager.js`);
  const events = [];
  const original = RealtimeManager.emit;
  RealtimeManager.emit = (site, room, action, payload) => { events.push({ room, action, payload }); };
  try { await fn(); await new Promise((r) => setTimeout(r, 50)); } finally { RealtimeManager.emit = original; }
  return events;
}

let quoteName, customer;

test("a record's write is announced in its own room, with its new version", async () => {
  await as(OWNER, async () => {
    const { createCustomer } = await import(`${process.cwd()}/apps/erp/modules/crm/customers.js`);
    customer = await createCustomer({ customer_name: "Live Co", email: "live@co.test" });
    const quote = await loopar.newDocument("Quote", { customer, lines: [{ description: "Work", rate: 100 }] });
    await quote.save();
    quoteName = quote.name;
    assert.equal(await loopar.db.getValue("Quote", "__created_by__", quoteName), OWNER);

    const events = await capture(async () => {
      await (await loopar.getDocument("Quote", quoteName, { title: "Changed" })).save();
    });
    const mine = events.filter((e) => e.room === `doc:Quote/${quoteName}` && e.action === "updated");
    assert.ok(mine.length >= 1, "the record's room hears about it");
    assert.equal(mine.at(-1).payload.name, quoteName);
    assert.ok(mine.at(-1).payload.version != null, "with the new version");
    // Plain data only: a knex Raw (`__version__ + 1`) is circular and blows up socket.io.
    const stored = await loopar.db.getValue("Quote", "__version__", quoteName);
    assert.equal(mine.at(-1).payload.version, Number(stored), "the stored version, as a number");
    for (const e of events) assert.doesNotThrow(() => JSON.stringify(e.payload), `${e.room} ${e.action} is serializable`);
  });
});

test("a transition by someone else notifies the owner; the owner's own does not", async () => {
  await as(OWNER, async () => {
    await applyTransition(await loopar.getDocument("Quote", quoteName), "Mark rejected", {}, { system: true });
    await applyTransition(await loopar.getDocument("Quote", quoteName), "Revise", {}, { system: true });
  });
  await t.run(async () => {
    assert.equal(Number((await q()("Notification").where({ user: OWNER }).count({ c: "*" }).first()).c), 0, "your own moves are not news");
  });

  const events = await capture(() => as(null, async () => {
    // A customer on a public link: nobody signed in.
    await applyTransition(await loopar.getDocument("Quote", quoteName), "Mark approved", {}, { system: true });
    await loopar.comments.add({ document: "Quote", documentName: quoteName, comment: "Approved: by Jane Roe.", guest_name: "Jane Roe", status: loopar.comments.STATUS.APPROVED });
  }));

  await t.run(async () => {
    const rows = await q()("Notification").where({ user: OWNER });
    assert.equal(rows.length, 1, "the transition and its comment join one notification");
    assert.match(rows[0].subject, new RegExp(`Quote ${quoteName}`));
    assert.match(rows[0].message, /Mark approved/);
    assert.match(rows[0].message, /Jane Roe: Approved: by Jane Roe/);
    assert.equal(Number(rows[0].is_read), 0);
  });
  const pushed = events.filter((e) => e.room === `user:${OWNER}` && e.action === "notification");
  assert.ok(pushed.length >= 1, "pushed live to the owner's room");
});

test("a comment by another user notifies the owner", async () => {
  await as("other@x.test", async () => {
    await loopar.comments.add({ document: "Quote", documentName: quoteName, comment: "Call the customer tomorrow", status: loopar.comments.STATUS.APPROVED });
  });
  await new Promise((r) => setTimeout(r, 50));
  await t.run(async () => {
    const rows = await q()("Notification").where({ user: OWNER }).orderBy("id");
    assert.ok(rows.some((r) => /Call the customer tomorrow/.test(r.message)));
  });
});

test("each user reads and marks only their own notifications", async () => {
  const { default: Controller } = await import(`${process.cwd()}/apps/loopar/modules/core/entities/notification/notification-controller.js`);
  await as("other@x.test", async () => {
    const mine = await new Controller({}).actionMine();
    assert.deepEqual([mine.unread, mine.items.length], [0, 0]);
    const c = new Controller({}); c.data = { all: 1 };
    await c.actionMarkRead();
  });
  await as(OWNER, async () => {
    const mine = await new Controller({}).actionMine();
    assert.ok(mine.unread >= 1);
    assert.equal(mine.items.length, mine.unread);
    const c = new Controller({}); c.data = { names: [mine.items[0].name] };
    assert.equal((await c.actionMarkRead()).updated, 1);
    assert.equal((await new Controller({}).actionMine()).unread, mine.unread - 1);
  });
});
