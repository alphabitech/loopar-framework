import { test } from "node:test";
import assert from "node:assert/strict";
import "loopar"; // load the framework first: db-env and loopar import each other
import { SystemValidation } from "../../packages/loopar/core/server/router/router-utils.js";
import { connectionFromInstallData } from "../../packages/loopar/core/global/install-connection.js";

const tenant = (flags, dbConfig = {}) => ({ ...flags, getDbConfig: () => dbConfig });
const INSTALL = "/loopar/system/install";
const UPDATE = "/loopar/system/update";

test("setup state: a fresh tenant goes to the install wizard, connected or not", () => {
  for (const DBServerInitialized of [false, true]) {
    const t = tenant({ DBServerInitialized, DBInitialized: false, __installed__: false, __wasInstalled__: false },
      { dialect: "mysql", connection: {} });
    assert.equal(SystemValidation.getRedirectPath(t), INSTALL);
  }
});

test("setup state: an installed tenant has no setup page", () => {
  const t = tenant({ DBServerInitialized: true, DBInitialized: true, __installed__: true, __wasInstalled__: true },
    { dialect: "mysql", database: "db_x" });
  const status = SystemValidation.getStatus(t);
  assert.equal(status.isFullyInstalled, true);
  assert.equal(SystemValidation.getRedirectPath(t), null);
});

test("setup state: an existing install with schema drift goes to update", () => {
  const t = tenant({ DBServerInitialized: true, DBInitialized: true, __installed__: false, __wasInstalled__: true },
    { dialect: "mysql", database: "db_x" });
  assert.equal(SystemValidation.getRedirectPath(t), UPDATE);
});

test("setup state: a configured database whose server is down is an outage, not a fresh install", () => {
  const t = tenant({ DBServerInitialized: false, DBInitialized: false, __installed__: false, __wasInstalled__: false },
    { dialect: "mysql", database: "db_x" });
  const status = SystemValidation.getStatus(t);
  assert.equal(status.dbUnavailable, true);
  assert.equal(status.needsInstall, false);
  assert.equal(SystemValidation.getRedirectPath(t), null);
});

test("wizard connection: built fresh with the engine's default port", () => {
  assert.deepEqual(
    connectionFromInstallData({ db_dialect: "postgres", db_host: " db.local ", db_user: "app", db_password: "s3cret" }),
    { dialect: "postgres", connection: { host: "db.local", port: 5432, user: "app", password: "s3cret" } },
  );
  assert.equal(connectionFromInstallData({ db_dialect: "mysql" }).connection.port, 3306);
  assert.equal(connectionFromInstallData({ db_dialect: "mysql", db_port: "3307" }).connection.port, "3307");
});

test("wizard connection: SQLite carries no server fields; no engine means keep db.config", () => {
  assert.deepEqual(
    connectionFromInstallData({ db_dialect: "sqlite", db_host: "localhost", db_user: "root" }),
    { dialect: "sqlite", connection: {} },
  );
  assert.equal(connectionFromInstallData({}), null);
  assert.equal(connectionFromInstallData({ db_dialect: "" }), null);
});
