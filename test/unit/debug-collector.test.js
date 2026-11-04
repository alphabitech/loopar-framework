import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { requestContext } from "../../packages/loopar/core/server/router/request-context.js";
import { DebugCollector, CORE_BUCKET, DEBUG_LIMITS } from "../../packages/loopar/core/debug/collector.js";
import { REDACTED } from "../../packages/loopar/core/debug/redact.js";

/**
 * The collector without a server or a database: a fake query probe feeds it
 * knex-shaped events, a fake req/res pair goes through its middleware inside
 * a tenant's request context.
 */
let collector;
let probe;

beforeEach(() => {
  collector = new DebugCollector();
  collector.install({
    enabled: true,
    console: false,
    addQueryProbe: (p) => { probe = p; return () => { probe = null; }; },
    resolveUser: () => "tester",
  });
});
afterEach(() => collector.uninstall());

let uid = 0;
const query = (sql, bindings = [], { error = null, rows = [] } = {}) => {
  const q = { sql, bindings, method: "select", __knexQueryUid: `q${++uid}` };
  probe.onQuery(q);
  if (error) probe.onError(new Error(error), q);
  else probe.onResponse(rows, q);
};

function fakeExchange(tenant, { method = "POST", url = "/api/Invoice/list", params = { document: "Invoice", action: "list" } } = {}) {
  const req = { method, originalUrl: url, headers: { cookie: "secret", "user-agent": "ua" }, query: { token: "t", page: 1 }, body: { password: "p", note: "n" } };
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200,
    writableFinished: true,
    headers: {},
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
  });
  const store = { req, res, tenant: { name: tenant } };
  return {
    req, res,
    /** Run `fn` as the request's handler, then finish the response. */
    async handle(fn) {
      await requestContext.run(store, () => new Promise((resolve, reject) => {
        collector.middleware()(req, res, async () => {
          try { req.__params__ = params; await fn(); resolve(); } catch (e) { reject(e); }
        });
      }));
      res.emit("finish");
    },
  };
}

test("a request records its route, user, redacted params and queries", async () => {
  const x = fakeExchange("t1");
  await x.handle(async () => {
    query("select * from `invoice` where `name` = ?", ["A-1"], { rows: [{}, {}] });
    query("update `user` set `password` = ? where `name` = ?", ["new", "u"], { rows: 1 });
  });

  const { total, rows } = collector.requests("t1");
  assert.equal(total, 1);
  assert.equal(x.res.headers["x-loopar-debug"], rows[0].id);
  assert.equal(rows[0].user, "tester");
  assert.equal(rows[0].document, "Invoice");
  assert.equal(rows[0].queryCount, 2);

  const detail = collector.request("t1", rows[0].id);
  assert.deepEqual(detail.params.query, { token: REDACTED, page: 1 });
  assert.deepEqual(detail.params.body, { password: REDACTED, note: "n" });
  assert.equal(detail.headers.cookie, undefined);
  assert.equal(detail.queries[0].rows, 2);
  assert.deepEqual(detail.queries[1].bindings, [REDACTED, "u"]);
});

test("tenants never see each other's requests; out-of-request work goes to its own bucket", async () => {
  await fakeExchange("a").handle(async () => query("select 1"));
  await fakeExchange("b").handle(async () => {});
  query("select 2"); // no request context
  assert.equal(collector.requests("a").total, 1);
  assert.equal(collector.requests("b").total, 1);
  assert.equal(collector.request("b", collector.requests("a").rows[0].id), null);
  assert.equal(collector.queries(CORE_BUCKET).background.length, 1);
});

test("requests that never reached the router, and the debugger's own, are not kept", async () => {
  await fakeExchange("t", { params: null }).handle(async () => {});
  await fakeExchange("t", { params: { document: "Debugger", action: "requests" } }).handle(async () => {});
  assert.equal(collector.requests("t").total, 0);
});

test("repeated statements (N+1) and identical duplicates are flagged", async () => {
  const x = fakeExchange("t");
  await x.handle(async () => {
    for (let i = 0; i < DEBUG_LIMITS.repeatedQuery; i++) query("select * from `item` where `id` = ?", [i]);
    query("select * from `cfg`");
    query("select * from `cfg`");
  });
  const [row] = collector.requests("t").rows;
  assert.equal(row.repeatedQueries, 1);
  assert.equal(row.duplicateQueries, 1);
  const detail = collector.request("t", row.id);
  assert.equal(detail.analysis.repeated[0].count, DEBUG_LIMITS.repeatedQuery);
});

test("failed queries, logs and errors attach to the request that caused them", async () => {
  const x = fakeExchange("t");
  await x.handle(async () => {
    query("select * from nope", [], { error: "no such table: nope" });
    collector.recordLog("warn", ["careful", { n: 1 }]);
    collector.recordError(new Error("boom"), { status: 500 });
  });
  const [row] = collector.requests("t").rows;
  assert.equal(row.errorCount, 1);
  const detail = collector.request("t", row.id);
  assert.match(detail.queries[0].error, /no such table/);
  assert.equal(detail.logs[0].text, "careful { n: 1 }");
  assert.equal(collector.errors("t", { level: "error" }).rows[0].requestId, row.id);
  assert.equal(collector.logs("t", { level: "warn" }).total, 1);
});

test("filters: status class, minimum duration, url text, since", async () => {
  const ok = fakeExchange("t", { url: "/desk/Invoice/list" });
  await ok.handle(async () => {});
  const bad = fakeExchange("t", { url: "/api/Invoice/save" });
  bad.res.statusCode = 500;
  await bad.handle(async () => {});

  assert.equal(collector.requests("t", { status: "5xx" }).total, 1);
  assert.equal(collector.requests("t", { status: "2xx" }).total, 1);
  assert.equal(collector.requests("t", { q: "desk/invoice" }).total, 1);
  assert.equal(collector.requests("t", { since: Date.now() + 1000 }).total, 0);
});

test("disabled: nothing is recorded", async () => {
  collector.uninstall();
  collector.install({ enabled: false, console: false, addQueryProbe: () => () => {} });
  await fakeExchange("t").handle(async () => {});
  assert.equal(collector.requests("t").total, 0);
  assert.equal(collector.recordError(new Error("x")), null);
});

test("a failed query keeps the driver's message, never the SQL with values knex interpolates", async () => {
  const x = fakeExchange("t", { url: "/auth/recoveryPassword?token=abc" });
  await x.handle(async () => {
    const q = { sql: "update `user` set `password` = ? where `name` = ?", bindings: ["$argon2id$v=19$secret", "u"], __knexQueryUid: "qe" };
    const err = new Error("update `user` set `password` = '$argon2id$v=19$secret' where `name` = 'u' - SQLITE_CONSTRAINT: UNIQUE failed");
    probe.onQuery(q);
    probe.onError(err, q);
    collector.recordError(err, { status: 500 });
  });
  const [row] = collector.requests("t").rows;
  assert.equal(row.url, `/auth/recoveryPassword?token=${REDACTED}`);
  const detail = collector.request("t", row.id);
  assert.equal(detail.queries[0].error, "SQLITE_CONSTRAINT: UNIQUE failed");
  const [e] = collector.errors("t").rows;
  assert.equal(e.text, "SQLITE_CONSTRAINT: UNIQUE failed");
  assert.ok(!e.stack.includes("argon2"), "stack has no bound values");
});

test("recordError never throws, whatever is thrown", () => {
  assert.doesNotThrow(() => collector.recordError(Object.create(null)));
});

test("live stream: recorded requests/logs/errors are pushed in batches to watched tenants only", async () => {
  collector.uninstall();
  const pushed = [];
  collector.install({
    enabled: true, console: false,
    addQueryProbe: (p) => { probe = p; return () => {}; },
    stream: { wants: (t) => t === "watched", publish: (tenant, kind, payload) => pushed.push({ tenant, kind, n: payload.rows.length }) },
  });
  await fakeExchange("watched").handle(async () => { collector.recordLog("info", ["hi"]); });
  await fakeExchange("unwatched").handle(async () => { collector.recordLog("info", ["hi"]); });
  await new Promise((r) => setTimeout(r, 500));
  assert.deepEqual(pushed.sort((a, b) => a.kind.localeCompare(b.kind)), [
    { tenant: "watched", kind: "logs", n: 1 },
    { tenant: "watched", kind: "requests", n: 1 },
  ]);
});
