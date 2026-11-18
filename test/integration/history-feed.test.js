import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { loopar } from "loopar";
import { bootTestTenant } from "../support/tenant.js";

/**
 * The record feed (audit events + comments) is served in pages: each page
 * carries its items' whole threads, and no item repeats or goes missing.
 */
const E = "Letterhead";
const RECORD = "LH feed";
let t;
let BaseController;

const q = () => loopar.db.qx();
const at = (minute) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();
const controller = () => Object.assign(new BaseController({}), { document: E });

async function event(name, minute, record = RECORD) {
  await q()("Document History").insert({ name, document: E, document_name: record, action: "Updated", event_at: at(minute) });
}
async function comment(name, minute, { parent = null, document = E, document_name = RECORD, status = 5 } = {}) {
  await q()("Comment").insert({ name, document, document_name, parent, user: "Tester", comment: name, status, created_at: at(minute) });
}

/** Walks every page and returns them. */
async function pages(options) {
  const out = [];
  let cursor = {};
  do {
    const page = await controller().fetchFeed(RECORD, { ...options, cursor });
    out.push(page);
    cursor = page.pagination.next;
    assert.ok(out.length < 50, "pagination must end");
    if (!page.pagination.hasMore) break;
  } while (true);
  return out;
}

before(async () => {
  t = await bootTestTenant();
  ({ default: BaseController } = await import(`${process.cwd()}/packages/loopar/core/controller/base-controller.js`));
  await t.run(async () => {
    // 12 events and 5 root comments interleaved in time, plus threads.
    for (let i = 1; i <= 12; i++) await event(`ev-${i}`, i * 10);
    for (let i = 1; i <= 5; i++) await comment(`root-${i}`, i * 20 + 5);
    await comment("reply-1", 200, { parent: "root-1" });
    await comment("reply-1-1", 201, { parent: "reply-1" });
    await comment("on-ev-2", 202, { document: "Document History", document_name: "ev-2" });
    await comment("on-ev-2-reply", 203, { document: "Document History", document_name: "ev-2", parent: "on-ev-2" });
    await comment("pending-root", 204, { status: 4 });
    await event("other-record", 300, "LH other");
  });
});
after(async () => { await t?.teardown(); });

const feedNames = (page) => page.rows
  .filter(r => r.action !== "Commented" || (!r.parent && r.document !== "Document History"))
  .map(r => r.name);

test("pages are newest first, complete and never overlap", async () => {
  await t.run(async () => {
    const all = await pages({ limit: 5 });
    const names = all.flatMap(feedNames);

    assert.equal(names.length, 18);                       // 12 events + 6 root comments
    assert.equal(new Set(names).size, 18);
    assert.ok(all.slice(0, -1).every(p => feedNames(p).length === 5));
    assert.equal(names[0], "pending-root");
    assert.equal(names.at(-1), "ev-1");
    assert.ok(!names.includes("other-record"));

    const times = all.flatMap(p => p.rows.filter(r => feedNames(p).includes(r.name)))
      .sort((a, b) => names.indexOf(a.name) - names.indexOf(b.name))
      .map(r => new Date(r.event_at).getTime());
    assert.deepEqual(times, [...times].sort((a, b) => b - a));
  });
});

test("a thread travels with the page of its feed item", async () => {
  await t.run(async () => {
    for (const page of await pages({ limit: 5 })) {
      const names = page.rows.map(r => r.name);
      assert.equal(names.includes("reply-1"), names.includes("root-1"));
      assert.equal(names.includes("reply-1-1"), names.includes("root-1"));
      assert.equal(names.includes("on-ev-2"), names.includes("ev-2"));
      assert.equal(names.includes("on-ev-2-reply"), names.includes("ev-2"));
    }
  });
});

test("the public view pages approved record comments only", async () => {
  await t.run(async () => {
    const all = await pages({ audit: false, onlyApproved: true, includeEvents: false, limit: 2 });
    const rows = all.flatMap(p => p.rows);

    assert.equal(all.length, 3);
    assert.deepEqual(all.flatMap(feedNames), ["root-5", "root-4", "root-3", "root-2", "root-1"]);
    assert.ok(rows.every(r => r.action === "Commented" && r.status === 5 && !("diff" in r)));
    assert.ok(rows.some(r => r.name === "reply-1-1"));
    assert.ok(!rows.some(r => r.name === "on-ev-2"));
  });
});

test("the page size defaults to 20 and is capped", async () => {
  await t.run(async () => {
    const first = await controller().fetchFeed(RECORD);
    assert.equal(feedNames(first).length, 18);
    assert.equal(first.pagination.hasMore, false);

    const one = await controller().fetchFeed(RECORD, { limit: 1 });
    assert.equal(feedNames(one).length, 1);
    assert.equal(one.pagination.hasMore, true);
  });
});
