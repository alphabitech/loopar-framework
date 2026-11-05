import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildHostRoutes } from "../../packages/loopar/bin/tenant/caddy-manager.js";

// tenant-builder resolves sites/ from the cwd at import time: work in a scratch dir.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "loopar-routing-"));
const cwd = process.cwd();
let tenant, normalizeRedirects;

before(async () => {
  process.chdir(root);
  ({ tenant, normalizeRedirects } = await import("../../packages/loopar/bin/tenant/tenant-builder.js"));
});

after(() => {
  process.chdir(cwd);
  fs.rmSync(root, { recursive: true, force: true });
});

test("redirects: only absolute paths to http(s) targets survive, without trailing slash", () => {
  assert.deepEqual(normalizeRedirects({
    "/api/Signup/*": "https://cloud.example.com/",
    "relative/*": "https://x.example.com",
    "/bad/*": "ftp://x.example.com",
    "/empty/*": "",
  }), { "/api/Signup/*": "https://cloud.example.com" });
});

test("redirects: stored on the tenant, kept across saves, removed when emptied", async () => {
  await tenant.saveTenant({ name: "old", domain: "old.example.com", redirects: { "/portal/*": "https://new.example.com" } });
  await tenant.saveTenant({ name: "old", status: "active" });
  assert.deepEqual(tenant.readTenant("old").redirects, { "/portal/*": "https://new.example.com" });

  await tenant.saveTenant({ name: "web", domain: "web.example.com", sites: { "extra.example.com": "site" } });
  const { domains, redirects } = tenant.routingTable();
  assert.deepEqual(domains.sort(), ["extra.example.com", "extra.example.com.localhost", "old.example.com", "web.example.com"]);
  assert.deepEqual(redirects, [{ host: "old.example.com", path: "/portal/*", to: "https://new.example.com" }]);

  await tenant.saveTenant({ name: "old", redirects: {} });
  const cfg = JSON.parse(fs.readFileSync(path.join(root, "sites", "old", "config.json"), "utf8"));
  assert.equal("redirects" in cfg, false);
});

test("caddy routes: redirects come before the proxy and keep the request URI", () => {
  const routes = buildHostRoutes(3000, ["a.example.com", "a.example.com"], [
    { host: "a.example.com", path: "/portal/*", to: "https://b.example.com" },
  ]);
  assert.deepEqual(routes.map((r) => r["@id"]), ["loopar_redirect_0", "loopar_host"]);
  assert.deepEqual(routes[0].match, [{ host: ["a.example.com"], path: ["/portal/*"] }]);
  assert.equal(routes[0].handle[0].status_code, 308);
  assert.deepEqual(routes[0].handle[0].headers.Location, ["https://b.example.com{http.request.uri}"]);
  assert.deepEqual(routes[1].match, [{ host: ["a.example.com"] }]);
  assert.deepEqual(buildHostRoutes(3000, [], []), []);
});
