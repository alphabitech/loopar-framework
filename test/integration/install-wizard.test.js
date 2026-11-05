/**
 * The install wizard owns the database connection: nothing is saved before
 * Install, so the engine can change up to the end.
 *
 *   - an unreachable server fails the install and writes nothing
 *   - switching engine (MySQL that never connected → SQLite) installs cleanly,
 *     with a fresh connection (no fields of the old engine left behind)
 */
import "loopar";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  loopar,
  tenant,
  getOrCreateTenantInstance,
  evictTenantInstance,
  requestContext,
} from "loopar";
import { ADMIN } from "../support/tenant.js";

const root = process.cwd();
const { default: Installer } = await import(path.join(root, "apps", "loopar", "installer.js"));

const name = `__loopar_wizard_${process.pid}__`;
const site = path.join(root, "sites", name);
const dbConfigFile = path.join(site, "config", "db.config.json");
// A MySQL server that is not there: nothing listens on port 1.
const unreachable = { dialect: "mysql", connection: { host: "127.0.0.1", port: "1", user: "root", password: "x" } };
const run = (fn) => requestContext.run({ tenant: { name } }, fn);
const readDbConfig = () => JSON.parse(fs.readFileSync(dbConfigFile, "utf8"));

const wizard = (db) => new Installer({
  app_name: "loopar",
  company: ADMIN.company,
  email: ADMIN.email,
  admin_password: ADMIN.password,
  confirm_password: ADMIN.password,
  ...db,
});

after(async () => {
  try { await run(async () => loopar.db?.knex?.destroy?.()); } catch { /* not loaded */ }
  evictTenantInstance(name);
  fs.rmSync(site, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("an unreachable server fails the install and leaves db.config untouched", async () => {
  fs.rmSync(site, { recursive: true, force: true });
  await tenant.saveTenant({ NAME: name, status: "active" });
  fs.mkdirSync(path.join(site, "config"), { recursive: true });
  fs.writeFileSync(dbConfigFile, JSON.stringify(unreachable));

  await getOrCreateTenantInstance(name);   // boots even though the saved server is down
  await run(async () => {
    await assert.rejects(
      wizard({ db_dialect: "mysql", db_host: "127.0.0.1", db_port: "1", db_user: "root", db_password: "x" }).install(),
      (e) => e.code === "DB_UNREACHABLE",
    );
    assert.deepEqual(readDbConfig(), unreachable);
    assert.equal(loopar.DBServerInitialized, false);
    assert.equal(loopar.__installed__, false);
  });
});

test("switching engine in the wizard installs on the new one with a fresh connection", async () => {
  await run(async () => {
    await wizard({ db_dialect: "sqlite", db_host: "127.0.0.1", db_user: "root" }).install();

    const config = readDbConfig();
    assert.equal(config.dialect, "sqlite");
    assert.deepEqual(config.connection, {}, "no MySQL fields left behind");
    assert.match(config.database, /^db_/);
    assert.equal(loopar.__installed__, true);
    assert.equal(await loopar.db.count("User", "Administrator"), 1);
  });
});
