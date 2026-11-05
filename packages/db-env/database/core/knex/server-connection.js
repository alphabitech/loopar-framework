'use strict';

/**
 * Server-level connections: the handle used for DDL on databases that may not
 * exist yet (CREATE / DROP DATABASE), and the install wizard's connection test.
 * They never target the tenant's own database.
 */
import knex from "knex";

export const DEFAULT_PORTS = { mysql: 3306, mariadb: 3306, postgres: 5432, mssql: 1433 };

const isSQLite = (dialect) => /sqlite/i.test(dialect || "");

/** knex options for a server-level connection of `config` ({ dialect, connection }). */
export function serverConnectionOptions(config = {}) {
  const dialect = config.dialect || "";
  const connection = { ...(config.connection || {}) };
  if (!connection.port && DEFAULT_PORTS[dialect]) connection.port = DEFAULT_PORTS[dialect];

  let client;
  if (/mysql|mariadb/i.test(dialect)) {
    client = "mysql2";
    // mysql2 doesn't require `database` for CREATE DATABASE — leave it.
  } else if (/postgres|cockroach|redshift/i.test(dialect)) {
    client = "pg";
    // PG always wants a DB to connect to: the maintenance DB.
    connection.database = "postgres";
  } else if (/mssql|sqlserver|tedious/i.test(dialect)) {
    client = "tedious";
    connection.database = "master";
  } else if (/oracle/i.test(dialect)) {
    client = "oracledb";
  } else {
    client = dialect;
  }

  return { client, connection, pool: { min: 0, max: 2 } };
}

/**
 * Can `config` reach its database server? Opens a throwaway connection, runs
 * one query and closes it. Nothing is persisted. SQLite is a local file, so
 * it always can.
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function testServerConnection(config = {}) {
  if (isSQLite(config.dialect)) return { ok: true };
  if (!config.dialect) return { ok: false, error: "No database engine selected." };

  const probe = knex({
    ...serverConnectionOptions(config),
    acquireConnectionTimeout: 10_000,
  });
  try {
    await probe.raw(/oracle/i.test(config.dialect) ? "SELECT 1 FROM DUAL" : "SELECT 1");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  } finally {
    await probe.destroy().catch(() => {});
  }
}
