import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// tenant-builder resolves sites/ from the cwd at import time: work in a scratch dir.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "loopar-limits-"));
const cwd = process.cwd();
let tenant, normalizeLimits;

before(async () => {
  process.chdir(root);
  ({ tenant, normalizeLimits } = await import("../../packages/loopar/bin/tenant/tenant-builder.js"));
});

after(() => {
  process.chdir(cwd);
  fs.rmSync(root, { recursive: true, force: true });
});

const config = (name) => JSON.parse(fs.readFileSync(path.join(root, "sites", name, "config.json"), "utf8"));

test("limits: positive integers only; anything else means no limit", () => {
  assert.deepEqual(normalizeLimits({ users: "10", mailboxes: 0, bad: "x", "Not-A-Key": 3 }), { users: 10 });
  assert.deepEqual(normalizeLimits(null), {});
});

test("limits: stored on the tenant, kept across saves, removed when emptied", async () => {
  await tenant.saveTenant({ name: "acme", status: "active", limits: { users: 5 } });
  await tenant.saveTenant({ name: "acme", domain: "acme.example.com" });
  assert.deepEqual(tenant.readTenant("acme").limits, { users: 5 });
  await tenant.saveTenant({ name: "acme", limits: { users: "" } });
  assert.equal("limits" in config("acme"), false);
});
