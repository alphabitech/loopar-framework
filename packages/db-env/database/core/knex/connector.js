'use strict';

/**
 * Knex-backed connector for loopar.
 *
 * Per-dialect drivers:
 *   - SQLite          → better-sqlite3 (synchronous, no event-loop cost
 *                       on per-tenant file I/O).
 *   - MySQL / MariaDB → mysql2.
 *   - Postgres        → pg.
 *   - MSSQL           → tedious.
 *
 * Each `connectXxx` method handles the same fall-back chain: try the
 * named tenant DB, then a maintenance DB if it doesn't exist yet (so we
 * can run CREATE DATABASE). When the server itself can't be reached the
 * connector stays without a connection — no silent SQLite fallback.
 */

import { loopar, fileManage } from "loopar";
import knex from "knex";
import Core from "./core.js";
import { serverConnectionOptions } from "./server-connection.js";

export default class Connector extends Core {
  /**
   * The configured server can't be reached: stay without a connection. The
   * tenant still boots (DBServerInitialized = false) so the install wizard or
   * the outage page can answer. Falling back to SQLite used to hide the
   * outage, or install on an engine nobody chose.
   */
  #serverUnreachable(engine, error) {
    this.knex = null;
    console.error(`[Knex Connector] ${engine} server not reachable: ${error?.message || error}`);
  }

  async connectWithSqlite() {
    try {
      await fileManage.makeFolder("sites", loopar.tenantId, "database");
      const dbPath = loopar.makePath(
        loopar.pathRoot, "sites", loopar.tenantId, "database", `${loopar.tenantId}.sqlite`
      );

      this.knex = knex({
        client: "better-sqlite3",
        connection: { filename: dbPath },
        useNullAsDefault: true,
        pool: { min: 1, max: 1 },
      });
    } catch (e) {
      loopar.throw("SQLite database not possible to connect");
    }
  }

  /**
   * Connect to MySQL/MariaDB. Same fall-back chain:
   * if the named DB doesn't exist yet we retry against information_schema so
   * we can run CREATE DATABASE; if even that fails the server is unreachable.
   */
  async connectMySQL(database = null) {
    const dbConfig   = this.dbConfig;
    const connection = dbConfig.connection || {};

    try {
      this.knex = knex({
        client: "mysql2",
        connection: {
          host: connection.host || dbConfig.host || "localhost",
          port: connection.port || dbConfig.port || 3306,
          user: connection.user || dbConfig.user,
          password: connection.password || dbConfig.password,
          database: database || dbConfig.database,
          // mysql2 accepts named placeholders if we ever need them
          namedPlaceholders: true,
        },
        pool: { min: 0, max: 5, acquireTimeoutMillis: 30_000, idleTimeoutMillis: 10_000 },
        ...dbConfig.options,
      });

      await this.knex.raw("SELECT 1");
    } catch (e) {
      if (!database) {
        await this.connectMySQL("information_schema");
      } else {
        this.#serverUnreachable("MySQL", e);
      }
    }
  }

  /**
   * Connect to PostgreSQL. Mirrors connectMySQL: when the named DB doesn't
   * exist yet we retry against the always-present `postgres` system DB so
   * that CREATE DATABASE can run. The fallback chain ends unconnected the
   * same way.
   *
   * Note PG doesn't have an equivalent of MySQL's information_schema-as-a-
   * fallback-DB — `information_schema` in PG is a SCHEMA inside whichever
   * DB you're connected to, not a DB you can connect to. Use `postgres`
   * (the maintenance DB created by initdb) instead.
   */
  async connectPostgres(database = null) {
    const dbConfig = this.dbConfig;
    const connection = dbConfig.connection || {};

    try {
      this.knex = knex({
        client: "pg",
        connection: {
          host: connection.host || dbConfig.host || "localhost",
          port: connection.port || dbConfig.port || 5432,
          user: connection.user || dbConfig.user,
          password: connection.password || dbConfig.password,
          // libpq defaults `database` to the username when omitted, which
          // surprises everyone. Provide an explicit fallback to `postgres`.
          database: database || dbConfig.database || "postgres",
        },
        pool: { min: 0, max: 5, acquireTimeoutMillis: 30_000, idleTimeoutMillis: 10_000 },
        ...dbConfig.options,
      });

      await this.knex.raw("SELECT 1");
    } catch (e) {
      if (!database) {
        await this.connectPostgres("postgres");
      } else {
        this.#serverUnreachable("PostgreSQL", e);
      }
    }
  }

  /**
   * Connect to MSSQL (Microsoft SQL Server) via tedious. Same fall-back
   * chain as the others — when the named DB doesn't exist yet we retry
   * against `master` so we can run CREATE DATABASE.
   */
  async connectMSSQL(database = null) {
    const dbConfig   = this.dbConfig;
    const connection = dbConfig.connection || {};

    try {
      this.knex = knex({
        client: "tedious",
        connection: {
          server: connection.host || dbConfig.host || "localhost",
          port: connection.port || dbConfig.port || 1433,
          user: connection.user || dbConfig.user,
          password: connection.password || dbConfig.password,
          database: database || dbConfig.database || "master",
          options: {
            trustServerCertificate: true,
            ...connection.options,
          },
        },
        pool: { min: 0, max: 5, acquireTimeoutMillis: 30_000, idleTimeoutMillis: 10_000 },
        ...dbConfig.options,
      });

      await this.knex.raw("SELECT 1");
    } catch (e) {
      if (!database) {
        await this.connectMSSQL("master");
      } else {
        this.#serverUnreachable("MSSQL", e);
      }
    }
  }

  /**
   * Connect to Oracle via oracledb. Oracle has no per-tenant CREATE
   * DATABASE concept — schemas are users — so the fallback chain is
   * different: there's no maintenance DB to retry against. If the user/
   * schema doesn't exist, the connector stays unconnected.
   *
   * NOTE: oracledb requires Oracle Instant Client installed on the host
   * (LD_LIBRARY_PATH / DYLD_LIBRARY_PATH set). Without it, the import
   * itself throws a meaningful error.
   */
  async connectOracle() {
    const dbConfig   = this.dbConfig;
    const connection = dbConfig.connection || {};

    try {
      this.knex = knex({
        client: "oracledb",
        connection: {
          host:     connection.host     || dbConfig.host || "localhost",
          port:     connection.port     || dbConfig.port || 1521,
          user:     connection.user     || dbConfig.user,
          password: connection.password || dbConfig.password,
          // Oracle uses "service name" or "SID" instead of database. We use
          // dbConfig.database as either; oracledb accepts both shapes.
          database: dbConfig.database,
          ...connection,
        },
        pool: { min: 0, max: 5, acquireTimeoutMillis: 30_000, idleTimeoutMillis: 10_000 },
        ...dbConfig.options,
      });

      await this.knex.raw("SELECT 1 FROM DUAL");
    } catch (e) {
      this.#serverUnreachable("Oracle", e);
    }
  }

  /**
   * Backend-agnostic alias for the underlying ORM/query-builder instance.
   * Lets business code grab the
   * raw engine via `loopar.db.client` regardless of which backend is active.
   * For most needs prefer `loopar.db.raw()` / `loopar.db.rawQuery()`.
   */
  get client() { return this.knex; }

  /**
   * Lazy second connection used to run DDL against a different DB on the
   * same server (e.g. CREATE DATABASE). For SQLite there is no concept of a
   * separate "core" connection — the file IS the schema.
   *
   * The `client` and target-DB conventions differ per dialect:
   * - mysql/mariadb → client `mysql2`, no target DB needed for CREATE
   * - postgres → client `pg`, must connect to an existing DB
   * (`postgres` is the conventional maintenance DB)
   */
  get coreConnection() {
    if (this.isSQLiteLike) return this.knex;
    this._coreConnection ??= knex(serverConnectionOptions(this.dbConfig));
    return this._coreConnection;
  }

  async #initialize() {
    if (this.isSQLiteLike) { await this.connectWithSqlite(); return; }
    if (this.isMySQLLike) { await this.connectMySQL(); return; }
    if (this.isPostgresLike) { await this.connectPostgres(); return; }
    if (this.isMSSQL) { await this.connectMSSQL(); return; }
    if (this.isOracle) { await this.connectOracle(); return; }

    console.warn(`[Knex Connector] Unsupported dialect "${this.dialect}", falling back to SQLite`);
    await this.connectWithSqlite();
  }

  async initialize() {
    await this.#initialize();
  }

  async testDatabase() {
    if (this.isSQLiteLike) return true;

    try {
      let raw;
      if (this.isMySQLLike) {
        raw = await this.knex.raw(
          "SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = ?",
          [this.database]
        );
      } else if (this.isPostgresLike) {
        raw = await this.knex.raw(
          "SELECT datname FROM pg_database WHERE datname = ?",
          [this.database]
        );
      } else if (this.isMSSQL) {
        raw = await this.knex.raw(
          "SELECT name FROM sys.databases WHERE name = ?",
          [this.database]
        );
      } else if (this.isOracle) {
        raw = await this.knex.raw(
          "SELECT username FROM all_users WHERE username = ?",
          [this.database.toUpperCase()]
        );
      } else {
        throw new Error(`Cannot verify database existence for dialect: ${this.dialect}`);
      }
      
      const rows = this.unwrapRawRows(raw);
      const exists = rows.length > 0;
      if (exists) loopar.printSuccess("Database connected successfully");
      else        loopar.printError(`Database "${this.database}" does not exist on the server`);
      return exists;
    } catch (e) {
      loopar.printError("Database connection test failed: " + e.message);
      return false;
    }
  }

  async testServer() {
    try {
      await this.coreConnection.raw("SELECT 1+1 as result");
      loopar.printSuccess("\nDatabase server is running\n");
      return true;
    } catch (e) {
      console.error(["Database Server Error", e]);
      loopar.printError("\nDatabase server is not running\n");
      return false;
    }
  }

  /**
   * Verify that loopar's expected entities and their fields actually exist.
   */
  async testFramework(app) {
    if (!loopar.DBServerInitialized || !loopar.DBInitialized) {
      loopar.printError("Loopar framework is not installed");
      return false;
    }

    const entities = loopar.getEntities(app).filter(e => !e.__deleted_at__);

    if (entities.length === 0) return false;

    // Audit columns (`__created_at__`, `__created_by__`, …) ARE probed: they
    // only appear in `__FIELDS__` for auditable entities, and a missing one
    // must flip __installed__ to false so the tenant is routed through
    // /system/update (ensureFrameworkColumns adds it) instead of crashing on
    // the first SELECT that asks for it.
    const testFields = async (entityName, columns, skip) => {
      const probedCols = columns.filter(c => !skip.has(c));
      if (!probedCols.length) return true;

      try {
        const escapedCols = probedCols.map(c => this.knex.ref(c).toQuery()).join(", ");
        const escapedTable = this.knex.ref(entityName).toQuery();
        await this.knex.raw(`SELECT ${escapedCols} FROM ${escapedTable} WHERE 1=2`);
        return true;
      } catch (error) {
        console.error(["Failed to test fields for", entityName, ":", error.message]);
        return false;
      }
    };

    for (const entity of entities) {
      const ref = loopar.getRef(entity.name);

      // Skip is_single only — those use the EAV table (Document Single
      // Values) and have no per-field columns to probe. Builders (Entity,
      // Builder) DO have physical tables with their declared columns;
      // skipping them was the bug that let drift in Entity's own schema
      // (e.g. a new `is_virtual` field) slip past testFramework, so
      // __installed__ stayed true and the eventual SELECT crashed
      // instead of routing the tenant through /system/update.
      if (ref.is_single || ref.is_virtual) continue;

      const exists   = await this.hasTable(entity.name);
      // FORM_TABLE fields live in __FIELDS__ for the save chain but have
      // no physical column on the parent table — they're materialised as
      // rows in the related child table. Skip them during the probe.
      const skipCols = new Set(ref.__FORM_TABLE_FIELDS__ || []);
      const fieldsOk = await testFields(entity.name, ref.__FIELDS__, skipCols);

      if (!exists || !fieldsOk) {
        loopar.printError(`Loopar framework is not installed (failed on: ${entity.name})`);
        return false;
      }
    }

    loopar.printSuccess("Loopar framework is installed");
    return true;
  }
}
