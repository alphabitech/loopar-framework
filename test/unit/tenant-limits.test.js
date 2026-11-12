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

test("domain_suffix: the one text limit, normalized with its leading dot", () => {
  assert.deepEqual(normalizeLimits({ domain_suffix: "Loopar.Build" }), { domain_suffix: ".loopar.build" });
  assert.deepEqual(normalizeLimits({ domain_suffix: ".loopar.build", users: 3 }), { domain_suffix: ".loopar.build", users: 3 });
  assert.deepEqual(normalizeLimits({ domain_suffix: "not a domain" }), {});
});

test("domain_suffix: a new domain outside it is refused, in the primary domain or a site", async () => {
  await tenant.saveTenant({ name: "sub", status: "active", domain: "sub.loopar.build", limits: { domain_suffix: ".loopar.build" } });

  await assert.rejects(tenant.saveTenant({ name: "sub", domain: "mybrand.com" }), /custom domain/);
  await assert.rejects(tenant.saveTenant({ name: "sub", sites: { "shop.mybrand.com": "shop" } }), /shop\.mybrand\.com/);
  assert.equal(config("sub").domain, "sub.loopar.build");

  // Under the suffix, or local, is fine; so is any save that adds no domain.
  await tenant.saveTenant({ name: "sub", sites: { "shop.loopar.build": "shop", "sub.localhost": "dev" } });
  await tenant.saveTenant({ name: "sub", status: "suspended" });
  assert.deepEqual(Object.keys(config("sub").sites), ["shop.loopar.build", "sub.localhost"]);
});

test("domain_suffix: a limit that arrives later keeps the domains the workspace already had", async () => {
  await tenant.saveTenant({ name: "own", status: "active", domain: "mybrand.com", sites: { "www.mybrand.com": "site" } });
  await tenant.saveTenant({ name: "own", limits: { domain_suffix: ".loopar.build" } });
  assert.equal(config("own").domain, "mybrand.com");

  await tenant.saveTenant({ name: "own", sites: { "www.mybrand.com": "site", "own.loopar.build": "site" } });
  await assert.rejects(tenant.saveTenant({ name: "own", sites: { "www.mybrand.com": "site", "other.com": "site" } }), /other\.com/);

  // Without the limit, anything goes again.
  await tenant.saveTenant({ name: "own", limits: {} });
  await tenant.saveTenant({ name: "own", domain: "other.com" });
  assert.equal(config("own").domain, "other.com");
});
