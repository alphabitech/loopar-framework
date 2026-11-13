import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// tenant-builder resolves sites/ from the cwd at import time: work in a scratch dir.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "loopar-destroy-"));
const cwd = process.cwd();
let tenant, tenantOps;

before(async () => {
  process.chdir(root);
  ({ tenant } = await import("../../packages/loopar/bin/tenant/tenant-builder.js"));
  tenantOps = await import("../../packages/loopar/bin/tenant/tenant-ops.js");
});

after(() => {
  process.chdir(cwd);
  fs.rmSync(root, { recursive: true, force: true });
});

test("a running tenant can't be destroyed or reset: it is turned off first", async () => {
  await tenant.saveTenant({ name: "live", status: "active" });

  assert.throws(() => tenantOps.assertStopped("live"), /is running/);
  await assert.rejects(tenantOps.destroyTenant("live"), /Turn it off first, then destroy it/);
  await assert.rejects(tenantOps.resetTenant("live"), /Turn it off first, then reset it/);
  assert.ok(fs.existsSync(path.join(root, "sites", "live", "config.json")), "nothing was removed");
});

test("a suspended tenant passes the check", async () => {
  await tenant.saveTenant({ name: "off", status: "suspended" });
  assert.doesNotThrow(() => tenantOps.assertStopped("off"));
  assert.doesNotThrow(() => tenantOps.assertStopped("missing"));
});

test("throwaway test tenants (leading underscore) can be reset or destroyed", () => {
  assert.doesNotThrow(() => tenantOps.assertDisposable("__loopar_wizard_197__"));
  assert.doesNotThrow(() => tenantOps.assertDisposable("my-site_2"));
});

test("names that aren't a plain sites/ folder are refused", () => {
  for (const name of ["", null, "..", "../etc", "a/b", "a.b", "-rf", "a b"]) {
    assert.throws(() => tenantOps.assertDisposable(name), /Invalid tenant name/, String(name));
  }
});

test("a tenant connected to a server but never installed has no database to drop", async () => {
  await tenant.saveTenant({ name: "halfway", status: "suspended" });
  const site = path.join(root, "sites", "halfway");
  fs.mkdirSync(path.join(site, "database"), { recursive: true });
  fs.writeFileSync(
    path.join(site, "config", "db.config.json"),
    JSON.stringify({ dialect: "mysql", connection: { host: "127.0.0.1", port: "1", user: "root", password: "x" } }),
  );

  assert.equal(await tenantOps.dropTenantDatabase("halfway"), "none");
  assert.equal(fs.existsSync(path.join(site, "database")), false);
});
