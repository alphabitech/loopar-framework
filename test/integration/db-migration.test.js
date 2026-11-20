/**
 * Moving a tenant's database to another engine (core/db-migration).
 *
 * Needs a reachable PostgreSQL server; skipped otherwise:
 *   LOOPAR_TEST_PG='{"host":"localhost","port":5432,"user":"postgres","password":"…"}' yarn test
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  loopar,
  getOrCreateTenantInstance,
} from "loopar";
import knexFactory from "knex";
import { bootTestTenant } from "../support/tenant.js";
import { convertValue, migrateDatabase } from "../../packages/loopar/core/db-migration/migrate.js";
import { startMigrationJob, backupJob } from "../../packages/loopar/core/backup/core-ops.js";

const PG = process.env.LOOPAR_TEST_PG ? JSON.parse(process.env.LOOPAR_TEST_PG) : null;
const skip = PG ? false : "LOOPAR_TEST_PG not set";

const dbName = (suffix) => `loopar_mig_${process.pid}_${suffix}`;
const pgAdmin = () => knexFactory({ client: "pg", connection: { ...PG, database: "postgres" } });
async function databaseExists(name) {
  const k = pgAdmin();
  try { return (await k.raw("SELECT 1 FROM pg_database WHERE datname = ?", [name])).rows.length > 0; }
  finally { await k.destroy(); }
}
async function dropDatabase(name) {
  const k = pgAdmin();
  try { await k.raw(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); } finally { await k.destroy(); }
}

test("convertValue: values SQLite let through", () => {
  const col = (type, extra = {}) => ({ type, nullable: true, maxLength: null, ...extra });
  assert.equal(convertValue("", col("integer")), null);
  assert.equal(convertValue("12", col("integer")), 12);
  assert.equal(convertValue("12.0", col("integer")), 12);
  assert.throws(() => convertValue("abc", col("integer")));
  assert.equal(convertValue("3.5", col("numeric")), 3.5);
  assert.equal(convertValue(1, col("boolean")), true);
  assert.equal(convertValue("0", col("boolean")), false);
  assert.ok(convertValue(1763424000000, col("timestamp with time zone")) instanceof Date);
  assert.equal(convertValue("2026-11-18 10:00:00", col("timestamp with time zone")), "2026-11-18 10:00:00");
  assert.equal(convertValue("0000-00-00 00:00:00", col("timestamp with time zone")), null);
  assert.throws(() => convertValue("yesterday", col("date")));
  assert.equal(convertValue(15, col("character varying", { maxLength: 10 })), "15");
  assert.equal(convertValue("", col("text")), "");
  assert.throws(() => convertValue("x".repeat(11), col("character varying", { maxLength: 10 })));
  assert.throws(() => convertValue("{bad", col("json")));
  assert.throws(() => convertValue(1793119200038, col("integer")));
  assert.equal(convertValue(1793119200038, col("bigint")), 1793119200038);
});

let t;
const counts = {};

before(async () => {
  if (skip) return;
  t = await bootTestTenant();
  await t.run(async () => {
    // A table no entity describes, with what SQLite tolerates.
    await loopar.db.knex.schema.createTable("Legacy Notes", (tb) => {
      tb.increments("id");
      tb.integer("qty");
      tb.datetime("seen_at");
      tb.string("note", 20);
      tb.integer("seen_ts");
    });
    await loopar.db.knex("Legacy Notes").insert([
      { id: 1, qty: "", seen_at: Date.now(), note: "empty qty", seen_ts: 1793119200038 },
      { id: 7, qty: "5", seen_at: "2026-11-18 10:00:00", note: "text qty" },
    ]);
    // A column the entity doesn't declare (an orphan) must survive.
    await loopar.db.knex.schema.alterTable("Role", (tb) => tb.string("legacy_flag"));
    await loopar.db.knex("Role").update({ legacy_flag: "kept" });

    for (const { name } of await loopar.db.raw("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")) {
      counts[name] = Number((await loopar.db.knex(name).count({ n: "*" }))[0].n);
    }
  });
});

after(async () => {
  if (skip) return;
  await t?.teardown();
  await dropDatabase(dbName("test"));
  await dropDatabase(dbName("real"));
});

test("a test run copies everything and leaves nothing behind", { skip }, async () => {
  const result = await t.run(() => migrateDatabase({
    target: { dialect: "postgres", connection: PG, database: dbName("test") },
    test: true,
  }));
  assert.equal(result.tables, Object.keys(counts).length);
  assert.equal(result.records, Object.values(counts).reduce((a, b) => a + b, 0));
  assert.ok(result.rebuiltFromSource.includes("Legacy Notes"));
  assert.equal(await databaseExists(dbName("test")), false, "the test database is dropped");
  await t.run(async () => assert.match(loopar.db.dialect, /sqlite/));
});

test("rejected values are reported and nothing changes", { skip }, async () => {
  await t.run(() => loopar.db.knex("Legacy Notes").insert({ id: 9, qty: "lots", note: "x" }));
  await assert.rejects(
    t.run(() => migrateDatabase({ target: { dialect: "postgres", connection: PG, database: dbName("bad") } })),
    (e) => {
      assert.equal(e.status, 422);
      assert.deepEqual(e.issues.map((i) => [i.table, i.column, i.problem]), [["Legacy Notes", "qty", "not an integer"]]);
      return true;
    },
  );
  assert.equal(await databaseExists(dbName("bad")), false);
  await t.run(async () => {
    assert.match(loopar.getDbConfig().dialect, /sqlite/);
    await loopar.db.knex("Legacy Notes").where({ id: 9 }).delete();
  });
});

test("the job moves the tenant and it boots on Postgres", { skip }, async () => {
  startMigrationJob({ tenant: t.name, target: { dialect: "postgres", connection: PG, database: dbName("real") } });
  let job;
  for (let i = 0; i < 600; i++) {
    job = backupJob(t.name);
    if (job?.finishedAt) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(job.error, null, job.error);
  assert.equal(job.ok, true);
  assert.ok(job.result.snapshot, "a pre-migrate snapshot was taken");

  await getOrCreateTenantInstance(t.name);   // re-initialized on the new database
  await t.run(async () => {
    assert.equal(loopar.getDbConfig().dialect, "postgres");
    assert.equal(loopar.__installed__, true, "the framework test passes on the target");
    for (const [table, n] of Object.entries(counts)) {
      assert.equal(Number((await loopar.db.knex(table).count({ n: "*" }))[0].n), n, table);
    }
    assert.equal(await loopar.db.getValue("User", "name", "Administrator"), "Administrator");
    const notes = await loopar.db.knex("Legacy Notes").orderBy("id");
    assert.equal(notes[0].qty, null);
    assert.ok(notes[0].seen_at instanceof Date);
    assert.equal(notes[1].qty, 5);
    assert.equal(Number(notes[0].seen_ts), 1793119200038, "an epoch-ms integer widens the column to BIGINT");
    assert.equal((await loopar.db.knex("Role").first("legacy_flag")).legacy_flag, "kept");

    // The sequence is past the copied ids.
    const [{ id }] = await loopar.db.knex("Legacy Notes").insert({ note: "new" }).returning("id");
    assert.equal(id, 8);

    // The ORM writes on the new engine (a document save would also rewrite
    // the app's installer.json, so the record goes through insertRow).
    await loopar.db.insertRow("Role", { name: "Migrated Role", app: "loopar" });
    assert.equal(await loopar.db.count("Role", "Migrated Role"), 1);
  });
});
