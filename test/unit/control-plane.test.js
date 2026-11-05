import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// tenant-builder resolves sites/ from the cwd at import time: work in a scratch dir.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "loopar-cp-"));
const cwd = process.cwd();
let tenant, ops;

before(async () => {
  process.chdir(root);
  ({ tenant } = await import("../../packages/loopar/bin/tenant/tenant-builder.js"));
  ops = await import("../../packages/loopar/bin/tenant/tenant-ops.js");
  await tenant.saveTenant({ name: "alpha", status: "active" });
  await tenant.saveTenant({ name: "beta", status: "active" });
});

after(() => {
  process.chdir(cwd);
  fs.rmSync(root, { recursive: true, force: true });
});

const config = (name) => JSON.parse(fs.readFileSync(path.join(root, "sites", name, "config.json"), "utf8"));

test("control plane: off by default and absent from config.json", () => {
  assert.equal(tenant.isControlPlane("alpha"), false);
  assert.equal("controlPlane" in config("alpha"), false);
  assert.equal(tenant.isControlPlane("missing"), false);
});

test("control plane: granted from the server, kept across later saves", async () => {
  await ops.setControlPlane("alpha", true);
  assert.equal(config("alpha").controlPlane, true);
  await tenant.saveTenant({ name: "alpha", domain: "alpha.example.com" });
  assert.equal(tenant.isControlPlane("alpha"), true);
  assert.deepEqual(tenant.controlPlaneTenants(), ["alpha"]);
});

test("control plane: protected from reset/destroy", () => {
  assert.throws(() => ops.assertDisposable("alpha"), /runs the control plane/);
  assert.doesNotThrow(() => ops.assertDisposable("beta"));
});

test("control plane: the last one can't be revoked", async () => {
  await assert.rejects(ops.setControlPlane("alpha", false), /last control-plane tenant/);
});

test("control plane: a tenant can't revoke its own from the Desk", async () => {
  await ops.setControlPlane("beta", true);
  assert.throws(() => ops.assertControlPlaneChange("beta", false, { actor: "beta" }), /workspace you're using/);
  assert.doesNotThrow(() => ops.assertControlPlaneChange("beta", false, { actor: "alpha" }));
});

test("control plane: form values (0/1) map to the flag", async () => {
  await tenant.saveTenant({ name: "beta", control_plane: 0 });
  assert.equal(tenant.isControlPlane("beta"), false);
  await tenant.saveTenant({ name: "beta", control_plane: "1" });
  assert.equal(tenant.isControlPlane("beta"), true);
  await tenant.saveTenant({ name: "beta", control_plane: "" });
  assert.equal(tenant.isControlPlane("beta"), true);
});
