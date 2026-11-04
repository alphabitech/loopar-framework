import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { EventEmitter } from "node:events";
import { loopar, requestContext } from "loopar";
import { addQueryProbe } from "db-env";
import { DebugCollector } from "../../packages/loopar/core/debug/collector.js";
import { bootTestTenant } from "../support/tenant.js";

/**
 * The Debugger module as a tenant installs it: page + Debug Token entity,
 * the token lifecycle, and the bearer gate of DebuggerController (which
 * actions a token may call, with which scope and verb).
 */
const MODULE = path.join(process.cwd(), "apps", "loopar", "modules", "debug");
let t, tokens, DebuggerController;

before(async () => {
  t = await bootTestTenant();
  tokens = await import(path.join(MODULE, "debug-tokens.js"));
  ({ default: DebuggerController } = await import(path.join(MODULE, "pages", "debugger", "debugger-controller.js")));
});
after(async () => { await t?.teardown(); });

/** Call a Debugger action the way the router does, as an /api RPC. */
async function call(action, { token, method = "GET", query = {}, data = {} } = {}) {
  const req = {
    method,
    ip: "127.0.0.1",
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    __ROUTE_MODE__: "rpc",
    __WORKSPACE_NAME__: "api",
  };
  const c = new DebuggerController({ req, res: {}, method, document: "Debugger", action, query, data, body: data });
  c.action = action;
  return await c.sendAction(action);
}

const rejects = (promise, status) => assert.rejects(promise, (e) => {
  assert.equal(Number(e.status ?? e.code), status, e.message);
  return true;
});

test("the module is installed: Debugger page and Debug Token entity", async () => {
  await t.run(async () => {
    assert.ok(loopar.getRef("Debugger"), "Debugger page ref");
    assert.ok(loopar.getRef("Debug Token"), "Debug Token entity ref");
    assert.equal(await loopar.db.count("Module", { name: "debug" }), 1);
  });
});

test("a token is shown once, stored hashed, and verifies with its scope", async () => {
  await t.run(async () => {
    const { token, info } = await tokens.createToken({ label: "agent", scope: "read", days: 1 });
    assert.match(token, /^ldbg_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/);
    const row = await loopar.db.query("Debug Token").where({ name: info.name }).first();
    assert.notEqual(row.token_hash, token);
    assert.ok(!JSON.stringify(row).includes(token.slice("ldbg_".length + 13)), "plaintext secret is not stored");

    const who = await tokens.verifyToken(token, { ip: "10.0.0.1" });
    assert.deepEqual(who, { name: info.name, label: "agent", scope: "read" });
    assert.equal((await loopar.db.query("Debug Token").where({ name: info.name }).first()).last_used_ip, "10.0.0.1");
  });
});

test("tampered, disabled, expired and revoked tokens are rejected with 401", async () => {
  await t.run(async () => {
    const { token, info } = await tokens.createToken({ label: "x" });
    await rejects(tokens.verifyToken(token.slice(0, -1) + (token.endsWith("A") ? "B" : "A")), 401);
    await rejects(tokens.verifyToken("not-a-token"), 401);

    await loopar.db.query("Debug Token").where({ name: info.name }).update({ disabled: 1 });
    await rejects(tokens.verifyToken(token), 401);
    await loopar.db.query("Debug Token").where({ name: info.name }).update({ disabled: 0, expires_at: new Date(Date.now() - 1000).toISOString() });
    await rejects(tokens.verifyToken(token), 401);
    await loopar.db.query("Debug Token").where({ name: info.name }).update({ expires_at: "" });
    assert.ok(await tokens.verifyToken(token));

    await tokens.revokeToken(info.name);
    await rejects(tokens.verifyToken(token), 401);
  });
});

test("a Debug Token can't be created without minting it (desk form path)", async () => {
  await t.run(async () => {
    const doc = await loopar.newDocument("Debug Token", { name: "abcdefabcdef", label: "manual", scope: "read" });
    await assert.rejects(doc.save(), /Debugger page/);
  });
});

test("bearer gate: read actions with a read token; runs need run scope and POST; desk-only actions refused", async () => {
  await t.run(async () => {
    const read = (await tokens.createToken({ label: "reader", scope: "read" })).token;
    const run = (await tokens.createToken({ label: "runner", scope: "run" })).token;

    const manifest = await call("manifest", { token: read });
    assert.equal(manifest.api.base, "/api/Debugger");
    const list = await call("requests", { token: read });
    assert.ok(Array.isArray(list.rows));
    const files = await call("testFiles", { token: read });
    assert.ok(files.files.some((f) => f.file === "test/integration/debugger.test.js"));

    await rejects(call("runTests", { token: read, method: "POST" }), 403);
    await rejects(call("runTests", { token: run, method: "GET" }), 405);
    await rejects(call("createToken", { token: run, method: "POST", data: { label: "escalate" } }), 403);
    await rejects(call("tokens", { token: run }), 403);
    await rejects(call("view", { token: read }), 403);
    await rejects(call("submitForm", { token: read, method: "POST" }), 403);
    await rejects(call("requests", { token: "ldbg_000000000000_" + "A".repeat(43) }), 401);
  });
});

test("without a session or token, nothing is public (inherited page actions are revoked)", async () => {
  await t.run(async () => {
    assert.ok(DebuggerController.revokedPublicActions.map((a) => a.toLowerCase()).includes("loadgalery"));
    await assert.rejects(call("loadGalery", { method: "POST" }));
    await assert.rejects(call("requests"));
  });
});

test("the collector sees the tenant's real queries (probe wired on connections opened before it)", async () => {
  const collector = new DebugCollector().install({ enabled: true, console: false, addQueryProbe });
  try {
    const req = { method: "GET", originalUrl: "/desk/App/list", headers: {}, query: {}, body: {} };
    const res = Object.assign(new EventEmitter(), {
      statusCode: 200, writableFinished: true, h: {},
      setHeader(k, v) { this.h[k] = v; }, getHeader(k) { return this.h[k]; },
    });
    await requestContext.run({ req, res, tenant: { name: t.name } }, () => new Promise((resolve, reject) => {
      collector.middleware()(req, res, async () => {
        try {
          req.__params__ = { document: "App", action: "list" };
          await loopar.db.getAll("App", ["name"]);
          await loopar.db.withTransaction(() => loopar.db.count("App", { name: "loopar" }));
          resolve();
        } catch (e) { reject(e); }
      });
    }));
    res.emit("finish");

    const [row] = collector.requests(t.name).rows;
    assert.ok(row, "request recorded");
    assert.ok(row.queryCount >= 2, `queries recorded (${row.queryCount})`);
    const detail = collector.request(t.name, row.id);
    assert.ok(detail.queries.some((q) => /app/i.test(q.sql) && q.tx), "transaction query attributed to the request");
  } finally {
    collector.uninstall();
  }
});

test("non-Bearer Authorization (proxy Basic auth) leaves the session path alone", () => {
  assert.equal(tokens.bearerFrom({ headers: { authorization: "Basic dXNlcjpwYXNz" } }), null);
  assert.equal(tokens.bearerFrom({ headers: {} }), null);
  assert.equal(tokens.bearerFrom({ headers: { authorization: "Bearer" } }), "");
  assert.equal(tokens.bearerFrom({ headers: { authorization: "bearer abc" } }), "abc");
});

test("the desk form can't widen a token: scope, hash and expiry are fixed at creation", async () => {
  await t.run(async () => {
    const { token, info } = await tokens.createToken({ label: "fixed", scope: "read", days: 1 });
    const doc = await loopar.getDocument("Debug Token", info.name);
    Object.assign(doc, { label: "renamed", scope: "run", expires_at: "", token_hash: "0".repeat(64) });
    await doc.save();
    const row = await loopar.db.query("Debug Token").where({ name: info.name }).first();
    assert.equal(row.label, "renamed");
    assert.equal(row.scope, "read");
    assert.notEqual(row.expires_at, "");
    assert.deepEqual(await tokens.verifyToken(token), { name: info.name, label: "renamed", scope: "read" });
  });
});
