/**
 * Throwaway tenant for integration tests.
 *
 *   const t = await bootTestTenant();          // fresh SQLite tenant, `loopar` app installed
 *   await t.run(() => loopar.db.getAll("App")); // runs inside the tenant's request context
 *   await t.teardown();                        // closes the DB and removes sites/<name>
 *
 * One tenant per test file (node:test runs files in separate processes, so the
 * name carries the pid). It is a real install — the same path a new site takes
 * (Installer → alterSchema → core tables → app data → roles → Administrator) —
 * so every integration test also covers the installer.
 *
 * Must run from the repo root (the framework resolves apps/ and sites/ from cwd).
 */
import fs from "node:fs";
import path from "node:path";
import {
  loopar,
  tenant,
  getOrCreateTenantInstance,
  evictTenantInstance,
  requestContext,
} from "loopar";

export const ADMIN = Object.freeze({
  company: "Loopar Test",
  email: "admin@loopar.test",
  password: "Test-Password-123!",   // meets the installer's password policy
});

export async function bootTestTenant({ name = `__loopar_test_${process.pid}__` } = {}) {
  const root = process.cwd();
  const site = path.join(root, "sites", name);
  if (!fs.existsSync(path.join(root, "apps", "loopar", "installer.js"))) {
    throw new Error(`[test] run tests from the repo root (cwd is ${root})`);
  }

  fs.rmSync(site, { recursive: true, force: true });
  await tenant.saveTenant({ NAME: name, status: "active" });
  fs.mkdirSync(path.join(site, "config"), { recursive: true });
  fs.writeFileSync(
    path.join(site, "config", "db.config.json"),
    JSON.stringify({ dialect: "sqlite", connection: {}, database: `db_${name}` }),
  );

  const run = (fn) => requestContext.run({ tenant: { name } }, fn);

  await getOrCreateTenantInstance(name);
  await run(async () => {
    const { default: Installer } = await import(path.join(root, "apps", "loopar", "installer.js"));
    await new Installer({
      app_name: "loopar",
      company: ADMIN.company,
      email: ADMIN.email,
      admin_password: ADMIN.password,
      confirm_password: ADMIN.password,
    }).install();
  });

  return {
    name,
    run,
    async teardown() {
      await run(() => loopar.db.knex?.destroy?.()).catch(() => {});
      evictTenantInstance(name);
      // Retries: SQLite may still be releasing its journal right after destroy().
      try {
        fs.rmSync(site, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch (e) {
        console.warn(`[test] could not remove ${site}: ${e.message}`);
      }
    },
  };
}
