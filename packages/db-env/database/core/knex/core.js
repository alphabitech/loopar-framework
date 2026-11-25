'use strict';

import {
  loopar,
  resolveColumnFormat,
  elementsDict,
  LEGACY_TAG_TO_FORMAT,
  AUDIT_COLUMN_SET,
  AUDIT_COLUMN_FAMILY,
  CREATED_BY_COLUMN,
  CREATED_BY_LENGTH,
  VERSION_COLUMN,
  AMENDED_FROM_COLUMN,
  CHILD_POSITION_COLUMN,
  isAuditableEntity,
  addAuditColumns,
  addPrimaryKey,
  COLUMN_FORMATS,
  requestContext,
} from "loopar";

/** Key of the per-request transaction states in the request's store. */
const TX_STATES = Symbol("db.transactions");

/**
 * Transaction states of the async flow that opened them (withTransaction /
 * detached). Work running concurrently inside the same request (a background
 * email delivery, an un-awaited task) has its own: it never joins, nor ends,
 * a transaction it did not open.
 */
const txScope = new AsyncLocalStorage();

import { AsyncLocalStorage } from "node:async_hooks";
import { orphanManager } from "./orphan-manager.js";
import { wireQueryProbes } from "./query-probes.js";

/** Format key a field's column is built with (data.format/type → element default → data). */
/** Default (precision, scale) of the fixed-precision formats — those of COLUMN_FORMATS' `sql`. */
const DECIMAL_DEFAULTS = { decimal: [10, 2], currency: [18, 4], percent: [7, 4] };

function resolveColumnFormatKey(field) {
  const fmt = resolveColumnFormat(field);
  if (fmt && COLUMN_FORMATS[fmt]) return fmt;

  // A simple connection holds one record name: VARCHAR like the `name` it
  // points to (a foreign key needs the same type). Multiple ones hold JSON.
  if (field?.element === "connection" && !isTrueFlag(field?.data?.multiple)) return "data";

  const tag = elementsDict[field?.element]?.def?.type;
  if (tag && LEGACY_TAG_TO_FORMAT.has(tag)) {
    const key = LEGACY_TAG_TO_FORMAT.get(tag);
    if (COLUMN_FORMATS[key]) return key;
  }
  return "data";
}

const TEXT_FORMATS = new Set(["text", "mediumtext", "longtext"]);
const isTrueFlag = (v) => [1, "1", true, "true"].includes(v);

/**
 * TEXT columns can't carry a UNIQUE/INDEX key without a prefix length on
 * MySQL/MariaDB (and not at all on MSSQL). A keyed field is always built as
 * VARCHAR (`data`, honoring data.length) so the key works on every dialect.
 */
function isKeyed(field) {
  return !!(field?.data?.unique || field?.data?.index);
}

export function resolveColumnSqlBuilder(field) {
  const key = resolveColumnFormatKey(field);
  if (TEXT_FORMATS.has(key) && isKeyed(field)) return COLUMN_FORMATS.data.sql;
  return COLUMN_FORMATS[key].sql;
}

/** Type family of each Knex column builder method (the one a format's `sql` calls). */
const BUILDER_FAMILY = {
  string: "string", text: "string",
  integer: "int", bigInteger: "int", increments: "int", bigIncrements: "int",
  float: "float", double: "double", decimal: "decimal",
  date: "date", datetime: "datetime", timestamp: "datetime", time: "time",
  boolean: "bool", json: "json", jsonb: "json", uuid: "uuid", binary: "blob",
};

/**
 * The type family a field's column is declared as: what its format's `sql`
 * builds, read by running it against a recording table. Every format counts
 * (also those added with registerColumnFormat), with nothing to keep in sync.
 */
function declaredColumnFamily(field) {
  let method = null;
  const chain = new Proxy(() => {}, { get: () => () => chain });
  const recorder = new Proxy({}, { get: (_, m) => () => { method ??= String(m); return chain; } });
  try {
    resolveColumnSqlBuilder(field)(recorder, field?.data?.name || "_", field?.data || {});
  } catch { /* a builder that needs the real Knex table: treat as text */ }
  return BUILDER_FAMILY[method] || "string";
}

/**
 * Text a column of the `family` type can take: how a value already stored
 * as text must look to survive the change of type (trimmed first).
 */
const NUMBER_TEXT = /^[-+]?(\d+\.?\d*|\.\d+)$/;
const CONVERTIBLE_TEXT = {
  int: (v) => /^[-+]?\d+$/.test(v),
  decimal: (v) => NUMBER_TEXT.test(v),
  float: (v) => NUMBER_TEXT.test(v) || /^[-+]?(\d+\.?\d*|\.\d+)e[-+]?\d+$/i.test(v),
  double: (v) => NUMBER_TEXT.test(v) || /^[-+]?(\d+\.?\d*|\.\d+)e[-+]?\d+$/i.test(v),
  bool: (v) => /^(0|1|true|false)$/i.test(v),
  date: (v) => /^\d{4}-\d{2}-\d{2}$/.test(v),
  datetime: (v) => /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$/i.test(v),
  time: (v) => /^\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(v),
  uuid: (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v),
  json: (v) => { try { JSON.parse(v); return true; } catch { return false; } },
};
/** Distinct values read to check a change of type (a sample on bigger columns: the engine checks the rest). */
const RETYPE_SAMPLE = 50000;

function escapeId(identifier, dialect) {
  if (!identifier) return "";
  const clean = identifier.replace(/[`'"]/g, "");
  // Same family check as the Core getters — keep them in sync if you add
  // a new postgres-shaped dialect (e.g. cockroachdb, redshift).
  if (/postgres|cockroach|redshift/i.test(dialect)) return `"${clean}"`;
  if (/mssql|sqlserver|tedious/i.test(dialect)) return `[${clean}]`;
  return `\`${clean}\``;
}

function buildColumn(table, field, { alter = false, adding = false } = {}) {
  const data = field.data || {};
  const name = data.name;
  if (!name) return;

  if (name === "id" || field.element === "id") {
    if (alter) return; // never re-issue PK during alter
    table.increments(name);
    return;
  }

  const builder = resolveColumnSqlBuilder(field);
  const col = builder(table, name, data);

  const hasConstantDefault = (
    data.default_value !== undefined &&
    data.default_value !== null &&
    data.default_value !== ""
  );

  // NOT NULL on ALTER ADD COLUMN requires a constant default (SQLite —
  // and some MySQL/MariaDB versions — reject otherwise, because the
  // pre-existing rows have no value to satisfy the constraint). When
  // adding to an existing table without a default we drop notNullable
  // at the DB level; the `required: 1` intent is still enforced at the
  // save layer via validateFields(), so app-driven inserts/updates
  // remain protected. CREATE TABLE and .alter() (table-rebuild) handle
  // notNullable fine, so they keep the constraint.
  if (data.required && (!adding || hasConstantDefault)) col.notNullable();

  if (data.unique && !alter) col.unique();

  if (hasConstantDefault) col.defaultTo(data.default_value);

  if (data.index && !alter) table.index(name);

  alter && col.alter();
}

export function safeDefaultForType(rawType) {
  const t = (rawType || "").toLowerCase();
  if (
    t.includes("int") || t.includes("float") || t.includes("double") ||
    t.includes("decimal") || t.includes("numeric") || t.includes("real") ||
    t.includes("bool")
  ) return 0;
  return "";
}

/** True when the SQL column type is numeric. */
function isNumericColumnType(rawType) {
  const t = (rawType || "").toLowerCase();
  return (
    t.includes("int") || t.includes("float") || t.includes("double") ||
    t.includes("decimal") || t.includes("numeric") || t.includes("real")
  );
}

function coerceValueForColumn(value, colMeta) {
  if (value === "" && isNumericColumnType(colMeta?.type)) return null;
  return value;
}

export default class Core {
  #tableColumnsCache = new Map();
  #knex = null;
  #savepointSeq = 0;

  // Every connection the connector opens goes through this setter, so query
  // probes (see query-probes.js) observe all of them. Replacing a connection
  // (a re-initialize, the connector's fallback chain) closes the previous
  // pool: it used to stay open, holding the database file for good.
  get knex() { return this.#knex; }
  set knex(instance) {
    const previous = this.#knex;
    this.#knex = wireQueryProbes(instance) ?? null;
    if (previous && previous !== instance) previous.destroy().catch(() => {});
  }

  constructor(config = null) {
    this.customConfig = config;
    this.transactionStack = [];
  }

  // A connection built with its own config (`new KnexORM(config)`, e.g. the
  // target of a database migration) never reads the tenant's db.config.
  get dbConfig() { return this.customConfig || loopar.getDbConfig(); }
  get database() { return this.dbConfig.database; }
  get dialect() { return this.dbConfig.dialect || ""; }

  get isMySQLLike() { return /mysql|mariadb/i.test(this.dialect); }
  get isPostgresLike() { return /postgres|cockroach|redshift/i.test(this.dialect); }
  get isSQLiteLike() { return /sqlite/i.test(this.dialect); }
  get isMSSQL() { return /mssql|sqlserver|tedious/i.test(this.dialect); }
  get isOracle() { return /oracle/i.test(this.dialect); }

  async getTableColumns(document) {
    if (this.#tableColumnsCache.has(document)) {
      return this.#tableColumnsCache.get(document);
    }
    const description = await this.getTableDescription(document);
    const colMap = new Map(description.map(f => [f.name.toLowerCase(), f]));
    this.#tableColumnsCache.set(document, colMap);
    return colMap;
  }

  async filterToTableColumns(document, data) {
    const colMap = await this.getTableColumns(document);
    const known = new Set(colMap.keys());
    const filtered = {};
    const dropped = [];
    for (const [key, value] of Object.entries(data)) {
      const lowerKey = key.toLowerCase();
      if (known.has(lowerKey)) {
        filtered[key] = coerceValueForColumn(value, colMap.get(lowerKey));
      } else {
        dropped.push(key);
      }
    }
    if (dropped.length) {
      console.warn(
        `[${document}] dropping unknown columns from row payload: ${dropped.join(', ')}`
      );
    }
    return filtered;
  }

  invalidateColumnsCache(document) {
    this.#tableColumnsCache.delete(document);
  }

  async getOrphanColumns(document) { return orphanManager.getOrphanColumns(this, document); }
  async releaseOrphanColumn(document, col) { return orphanManager.releaseOrphanColumn(this, document, col); }
  async dropOrphanColumn(document, col) { return orphanManager.dropOrphanColumn(this, document, col); }
  async restoreOrphanColumn(document, col) { return orphanManager.restoreOrphanColumn(this, document, col); }

  async alterSchema() {
    if (this.isSQLiteLike) return;

    if (this.isMySQLLike) {
      try {
        await this.coreConnection.raw(
          `CREATE DATABASE IF NOT EXISTS \`${this.database}\` ` +
          `CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
        );
      } catch (e) { console.error("Database creation error:", e.message); throw e; }
      return;
    }

    if (this.isPostgresLike) {
      try {
        await this.coreConnection.raw(`CREATE DATABASE "${this.database}"`);
      } catch (e) {
        if (e.code === "42P04") return;   // duplicate_database — already there
        console.error("Database creation error:", e.message);
        throw e;
      }
      return;
    }

    if (this.isMSSQL) {
      try {
        const exists = await this.coreConnection.raw(
          "SELECT name FROM sys.databases WHERE name = ?", [this.database]
        );
        if (this.unwrapRawRows(exists).length === 0) {
          await this.coreConnection.raw(`CREATE DATABASE [${this.database}]`);
        }
      } catch (e) { console.error("Database creation error:", e.message); throw e; }
      return;
    }

    if (this.isOracle) {
      // Oracle's notion of a "database" is a USER/SCHEMA. Creating one
      // requires DBA privileges and a tablespace; we don't want to do that
      // implicitly. Document the expectation: the operator pre-creates the
      // user, Loopar just connects.
      console.warn(
        "[alterSchema] Oracle requires a pre-existing user/schema; " +
        "Loopar does not auto-create it. Configure dbConfig.user to match."
      );
      return;
    }

    // Unknown dialect — best-effort plain CREATE without existence guard.
    try {
      await this.coreConnection.raw(`CREATE DATABASE "${this.database}"`);
    } catch (e) { console.error("Database creation error:", e.message); throw e; }
  }

  async dropSchema(schema) {
    const PROTECTED = new Set(["information_schema", "mysql", "postgres", "template0", "template1", "master", "tempdb", "model", "msdb"]);
    if (!schema || PROTECTED.has(schema)) throw new Error(`Cannot drop protected database: ${schema}`);
    try {
      const q = this.isMySQLLike ? `DROP DATABASE IF EXISTS \`${schema}\``
              : this.isMSSQL ? `IF DB_ID('${schema}') IS NOT NULL DROP DATABASE [${schema}]`
              : this.isOracle ? `DROP USER ${schema} CASCADE`
              : `DROP DATABASE IF EXISTS "${schema}"`;
      await this.coreConnection.raw(q);
    } catch (e) { console.error("Database drop error:", e.message); throw e; }
  }

  /**
   * The open transaction belongs to the request that opened it (its
   * AsyncLocalStorage store), never to the shared connection: a concurrent
   * request must not run its queries inside another request's transaction,
   * nor lose them to its rollback. Outside a request (boot, CLI) there is
   * one per database.
   */
  txState(create = false) {
    const scoped = txScope.getStore();
    if (scoped) {
      if (!scoped.has(this) && create) scoped.set(this, { trx: null, after: [] });
      return scoped.get(this) ?? null;
    }
    const store = requestContext.getStore();
    if (!store) {
      if (!this.#unscopedTx && create) this.#unscopedTx = { trx: null, after: [] };
      return this.#unscopedTx;
    }
    const states = store[TX_STATES] ??= new Map();
    if (!states.has(this) && create) states.set(this, { trx: null, after: [] });
    return states.get(this) ?? null;
  }

  #unscopedTx = null;

  #clearTx() {
    const scoped = txScope.getStore();
    if (scoped) { scoped.delete(this); return; }
    const store = requestContext.getStore();
    if (store) store[TX_STATES]?.delete(this);
    else this.#unscopedTx = null;
  }

  get transaction() { return this.txState()?.trx ?? null; }

  async beginTransaction() {
    if (this.transaction) throw new Error("Transaction already active");
    const trx = await this.knex.transaction();
    this.txState(true).trx = trx;
    return trx;
  }

  async safeRollback() {
    const trx = this.transaction;
    if (!trx) return;
    try   { await trx.rollback(); }
    catch (e) { console.error("Rollback failed:", e.message); }
    finally   { this.#clearTx(); }
  }

  async endTransaction() {
    const trx = this.transaction;
    if (!trx) return;
    try   { await trx.commit(); }
    catch (e) { console.error("Commit failed:", e.message); await this.safeRollback(); throw e; }
    finally   { this.#clearTx(); }
  }

  async rollbackTransaction() { await this.safeRollback(); }

  /**
   * Runs `fn` in a transaction: commits when it resolves, rolls back when it
   * throws. Inside an open transaction it just joins it (the outermost one
   * commits or rolls back).
   */
  async withTransaction(fn) {
    if (this.transaction) return await fn();
    // The transaction belongs to this async flow only (see txScope).
    return await txScope.run(new Map(), async () => {
      await this.beginTransaction();
      try {
        const result = await fn();
        await this.endTransaction();
        return result;
      } catch (e) {
        await this.safeRollback();
        throw e;
      }
    });
  }

  /**
   * Runs `fn` outside any open transaction, with its own scope: for work
   * started now and finished later (background deliveries), which must
   * neither write into the caller's transaction nor share its own.
   */
  async detached(fn) {
    return await txScope.run(new Map(), fn);
  }

  /**
   * Helper: return the active query interface (transaction if open, else
   * the bare connection). Use this instead of `this.knex` whenever a query
   * needs to enroll in the current transaction.
   */
  qx() { return this.transaction || this.knex; }

  /**
   * Returns a Knex query builder bound to the given logical document
   * name (resolved through the table prefix). The builder speaks the
   * fluent API the framework expects (.where / .orWhere / .select /
   * .first / etc.).
   *
   * Use this instead of reaching into `this.knex` directly so the call
   * automatically enrolls in the active transaction (via qx()).
   */
  query(tableName) {
    if (!this.knex) throw new Error('Database not initialized. Call initialize() first.');
    return this.qx()(tableName);
  }

  throw(error) {
    if (this.transaction) this.rollbackTransaction().catch(console.error);
    loopar.throw(error);
  }

  get masterSchema() {
    const map = {
      sqlite: "sqlite_master",
      mysql: "INFORMATION_SCHEMA.TABLES",
      postgres: "information_schema.tables",
      mssql: "INFORMATION_SCHEMA.TABLES",
      oracle: "user_tables",
    };
    const key = this.dialect.split(":")[0];
    if (!map[key]) throw new Error(`Database dialect not supported: ${key}`);
    return map[key];
  }

  /**
   * @param {string} name
   * @param {Array}  fields
   * @param {object} [opts]
   * @param {object} [opts.entityMeta] - { name, is_static, is_child,
   *   is_single, is_audited }. Passed by callers (Entity.save) so audit-
   *   column emission doesn't depend on loopar.getRef(), which is stale
   *   for a freshly-installed entity (its ref isn't built until the next
   *   buildRefs). Without this, createTable on install skips audit cols.
   */
  async makeTable(name, fields, opts = {}) {
    const entityMeta = opts.entityMeta || null;
    this.invalidateColumnsCache(name);
    if (await this.hasTable(name)) {
      const dbFields = await this.getTableDescription(name);
      await this.alterTable(name, fields, dbFields, entityMeta);
      await this.reconcileOrphanColumns(this.tableName(name), fields, dbFields);
    } else {
      await this.createTable(name, fields, entityMeta);
    }
    this.invalidateColumnsCache(name);
  }

  async hasTable(tableName) {
    // Case-insensitive lookup. SQLite treats identifiers as
    // case-insensitive in DDL (CREATE TABLE "Oauth Settings" collides
    // with an existing "OAuth Settings"), but `WHERE name = ?` against
    // sqlite_master is case-sensitive on the literal string. The
    // mismatch caused makeTable() to route to createTable on tables
    // that already existed under a different casing, and SQLite then
    // raised "table already exists". MySQL is case-insensitive on most
    // platforms but the collation can vary; Postgres stores quoted
    // identifiers verbatim. LOWER() on both sides gives consistent
    // behaviour across dialects.
    try {
      let rows;
      if (this.isMySQLLike) {
        rows = await this.qx().raw(
          "SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ? AND LOWER(TABLE_NAME) = LOWER(?) LIMIT 1",
          [this.database, tableName]
        );
      } else if (this.isSQLiteLike) {
        rows = await this.qx().raw(
          "SELECT name FROM sqlite_master WHERE type='table' AND LOWER(name) = LOWER(?) LIMIT 1",
          [tableName]
        );
      } else if (this.isPostgresLike) {
        rows = await this.qx().raw(
          "SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND LOWER(table_name) = LOWER(?) LIMIT 1",
          [tableName]
        );
      } else {
        // MSSQL / Oracle / others — generic information_schema fallback.
        rows = await this.qx().raw(
          "SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE LOWER(TABLE_NAME) = LOWER(?)",
          [tableName]
        );
      }
      const result = this.unwrapRawRows(rows);
      return Array.isArray(result) ? result.length > 0 : !!result;
    } catch (e) {
      console.error("Error checking table existence:", e.message);
      return false;
    }
  }

  async createTable(literalName, fields, entityMeta = null) {
    const auditable = this.#isAuditableTable(literalName, entityMeta);
    const child = this.#isChildTable(literalName, entityMeta);

    await this.qx().schema.createTable(literalName, (table) => {
      // utf8mb4 + InnoDB only matter on MySQL/MariaDB; Knex no-ops them elsewhere.
      if (this.isMySQLLike) {
        table.charset("utf8mb4");
        table.collate("utf8mb4_unicode_ci");
        table.engine("InnoDB");
      }

      addPrimaryKey(table);

      const process = (field) => {
        if (fieldHasColumn(field)) {
          if (this.#isFrameworkColumn(field?.data?.name, auditable)) {
            console.warn(
              `[createTable] ${literalName}: ignoring dev declaration of ` +
              `"${field.data.name}" — framework-managed column.`
            );
          } else {
            buildColumn(table, field);
          }
        }
        field.elements?.forEach(process);
      };
      fields.forEach(process);

      if (auditable) addAuditColumns(table, this.qx());
      if (child) table.integer(CHILD_POSITION_COLUMN).nullable();
    });
  }

  /** Child tables (form-table rows) carry CHILD_POSITION_COLUMN. */
  #isChildTable(name, entityMeta = null) {
    const flag = entityMeta ? entityMeta.is_child : loopar.getRef?.(name, false)?.is_child;
    return flag === 1 || flag === true || flag === "1";
  }

  /**
   * Adds CHILD_POSITION_COLUMN to an existing child table, seeding it with
   * `id` (the order rows had until now). Idempotent.
   */
  async ensureChildPosition(literalName) {
    if (this.#positioned.has(literalName)) return false;
    if (!(await this.hasTable(literalName))) return false;
    const columns = await this.getTableDescription(literalName);
    if (columns.some(c => c.name.toLowerCase() === CHILD_POSITION_COLUMN)) {
      this.#positioned.add(literalName);
      return false;
    }

    await this.qx().schema.alterTable(literalName, (t) => t.integer(CHILD_POSITION_COLUMN).nullable());
    await this.qx()(literalName).update({ [CHILD_POSITION_COLUMN]: this.knex.ref("id") });
    this.invalidateColumnsCache(literalName);
    this.#positioned.add(literalName);
    return true;
  }

  /** Child tables known to have CHILD_POSITION_COLUMN (see ensureChildPosition). */
  #positioned = new Set();

  #isFrameworkColumn(name, auditable) {
    if (!name) return false;
    const lower = name.toLowerCase();
    if (lower === "id" || lower === CHILD_POSITION_COLUMN) return true;
    if (auditable && AUDIT_COLUMN_SET.has(lower)) return true;
    return false;
  }

  #isAuditableTable(name, entityMeta = null) {
    if (entityMeta) return isAuditableEntity(entityMeta);
    const ref = loopar.getRef?.(name);
    if (!ref) return false;

    return ref.is_audited === 1 || ref.is_audited === true;
  }

  async alterTable(literalName, fields, existingFields, entityMeta = null) {
    const auditable = this.#isAuditableTable(literalName, entityMeta);
    const existingByName = new Map(
      existingFields.map(f => [f.name.toLowerCase(), f])
    );
    const newFields = [];
    const changedFields = [];
    let addAudit = false;

    const uniqueDeclared = [];

    const visit = (field) => {
      if (fieldHasColumn(field)) {
        const colName = field.data.name.toLowerCase();

        if (this.#isFrameworkColumn(field?.data?.name, auditable)) {
          console.warn(
            `[alterTable] ${literalName}: ignoring dev declaration of ` +
            `"${field.data.name}" — framework-managed column.`
          );
        } else {
          const existing = existingByName.get(colName);
          if (!existing) {
            newFields.push(field);
          } else if (
            this.#columnTypeFamilyChanged(field, existing) ||
            this.#decimalColumnTooNarrow(field, existing) ||
            this.#keyedTextColumn(field, existing) ||
            this.#textOnVarcharColumn(field, existing)
          ) {
            changedFields.push({ field, existing });
          }

          if (field.data?.unique) uniqueDeclared.push(field.data.name);
        }
      }
      field.elements?.forEach(visit);
    };
    fields.forEach(visit);

    if (auditable) {
      addAudit = this.#auditColumnsNeedAlter(existingByName);
    }

    if (this.#isChildTable(literalName, entityMeta) && !existingByName.has(CHILD_POSITION_COLUMN)) {
      await this.ensureChildPosition(literalName);
    }

    if (!newFields.length && !changedFields.length && !addAudit) return;

    for (const { field, existing } of changedFields) {
      const declared = resolveColumnFormat(field) || elementsDict[field.element]?.def?.type || "data";
      const note = this.isSQLiteLike ? " (SQLite: emulated via table-rebuild)" : "";
      console.log([
        `[alterTable] ${literalName}.${field.data.name}: type change`,
        `${existing.type} → ${declared}${note}`,
      ]);
    }

    // A column changing type can't keep a foreign key (PG/MySQL): the
    // framework's keys on this table go now and come back from the refs at
    // the next loopar.build() (core/document/foreign-keys.js).
    if (changedFields.length) await this.#prepareRetype(literalName, changedFields);
    if (changedFields.length) await this.dropFrameworkForeignKeys(literalName);

    await this.qx().schema.alterTable(literalName, (table) => {
      for (const field of newFields) buildColumn(table, field, { adding: true });
      for (const { field } of changedFields) buildColumn(table, field, { alter: true });

      if (addAudit) {
        this.#emitAuditColumnDelta(table, existingByName);
      }
    });

    if (addAudit) {
      const needsCreated = !existingByName.has("__created_at__");
      const needsUpdated = !existingByName.has("__updated_at__");
      if (needsCreated || needsUpdated) {
        const updates = {};
        if (needsCreated) updates.__created_at__ = this.qx().fn.now();
        if (needsUpdated) updates.__updated_at__ = this.qx().fn.now();
        await this.qx()(literalName).update(updates);
        console.log([
          `[alterTable] ${literalName}: backfilled audit timestamps for existing rows`,
          Object.keys(updates),
        ]);
      }
    }

    const newFieldNames = new Set(newFields.map(f => f.data?.name?.toLowerCase()));
    const ensureUnique  = uniqueDeclared.filter(
      n => !newFieldNames.has(n?.toLowerCase())
    );

    const uniqueExists = (e) => /already exists|duplicate key name|duplicate.*key/i.test(e?.message || "");
    for (const colName of ensureUnique) {
      try {
        const added = await this.tolerating(
          () => this.qx().schema.alterTable(literalName, (t) => t.unique(colName)),
          uniqueExists,
        );
        added && console.log([`[alterTable] ${literalName}.${colName}: UNIQUE constraint added`]);
      } catch (e) {
        console.error(`[alterTable] ${literalName}.${colName}: failed to add UNIQUE — ${e.message}`);
        throw e;
      }
    }
  }

  /**
   * Runs `fn`, swallowing the errors `expected` accepts (an index that is
   * already there, one that is missing). Returns false when one was swallowed.
   *
   * Postgres aborts the whole transaction on ANY failed statement, caught or
   * not: every later query fails with "current transaction is aborted". Inside
   * a transaction the attempt runs under a SAVEPOINT, so an expected failure
   * is rolled back alone and the transaction stays usable.
   */
  async tolerating(fn, expected) {
    const savepoint = this.isPostgresLike && this.transaction
      ? `sp_tolerate_${++this.#savepointSeq}`
      : null;

    savepoint && await this.qx().raw(`SAVEPOINT ${savepoint}`);
    try {
      await fn();
      savepoint && await this.qx().raw(`RELEASE SAVEPOINT ${savepoint}`);
      return true;
    } catch (e) {
      savepoint && await this.qx().raw(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      if (expected(e)) return false;
      throw e;
    }
  }

  /** Drops the framework's foreign keys (`fk_…`) declared on `table`. */
  async dropFrameworkForeignKeys(table) {
    if (this.isPostgresLike) {
      const rows = this.unwrapRawRows(await this.qx().raw(
        `SELECT con.conname AS name FROM pg_constraint con
           JOIN pg_class rel ON rel.oid = con.conrelid
           JOIN pg_namespace ns ON ns.oid = rel.relnamespace
          WHERE con.contype = 'f' AND ns.nspname = current_schema() AND rel.relname = ? AND con.conname LIKE 'fk\\_%'`, [table]));
      for (const { name } of rows) await this.qx().raw(`ALTER TABLE "${table}" DROP CONSTRAINT IF EXISTS "${name}"`);
    } else if (this.isMySQLLike) {
      const rows = this.unwrapRawRows(await this.qx().raw(
        `SELECT CONSTRAINT_NAME AS name FROM information_schema.TABLE_CONSTRAINTS
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_TYPE = 'FOREIGN KEY' AND CONSTRAINT_NAME LIKE 'fk\\_%'`, [this.database, table]));
      for (const { name } of rows) await this.qx().raw(`ALTER TABLE \`${table}\` DROP FOREIGN KEY \`${name}\``);
    }
  }

  /**
   * Meta tables (Entity and every builder table) are unique by `name`.
   * Restores UNIQUE(name) where an experimental UNIQUE(module, name) replaced
   * it (dev tenants only). Idempotent.
   */
  async ensureNameUniqueKey(literalName) {
    if (!(await this.qx().schema.hasTable(literalName))) return;

    const missing = (e) => /no such index|doesn't exist|does not exist|check that (column|it) exists|can't drop/i.test(e?.message || "");
    const present = (e) => /already exists|duplicate key name|duplicate/i.test(e?.message || "");

    const dropped = await this.tolerating(
      () => this.qx().schema.alterTable(literalName, (t) => t.dropUnique(["module", "name"])),
      missing,
    );
    dropped && console.log([`[name-identity] ${literalName}: UNIQUE(module, name) dropped`]);

    await this.tolerating(
      () => this.qx().schema.alterTable(literalName, (t) => t.unique(["name"])),
      present,
    );
  }

  #auditColumnsNeedAlter(existingByName) {
    for (const [name, family] of Object.entries(AUDIT_COLUMN_FAMILY)) {
      const existing = existingByName.get(name);
      if (!existing) return true;
      const existingFamily = this.#sqlTypeFamily(existing.type);
      if (existingFamily && existingFamily !== family) return true;
    }
    return false;
  }

  #emitAuditColumnDelta(table, existingByName) {
    const knex = this.qx();
    const ensure = (name, applyDef) => {
      const existing = existingByName.get(name);
      const expectedFamily = AUDIT_COLUMN_FAMILY[name];
      if (!existing) {
        applyDef(false);                           // add new
      } else if (this.#sqlTypeFamily(existing.type) !== expectedFamily) {
        applyDef(true);                            // alter existing
        console.log([`[alterTable] retyping audit col`, name, existing.type, '→', expectedFamily]);
      }
    };

    ensure("__created_at__", (alter) => {
      if (alter) {
        const c = table.timestamp("__created_at__").defaultTo(knex.fn.now());
        c.alter();
      } else {
        table.timestamp("__created_at__").nullable();
      }
    });
    ensure("__updated_at__", (alter) => {
      if (alter) {
        const c = table.timestamp("__updated_at__").defaultTo(knex.fn.now());
        c.alter();
      } else {
        table.timestamp("__updated_at__").nullable();
      }
    });
    ensure("__deleted_at__", (alter) => {
      const c = table.timestamp("__deleted_at__").nullable();
      if (alter) c.alter();
    });
    ensure("__document_status__", (alter) => {
      const c = table.integer("__document_status__").notNullable().defaultTo(1);
      if (alter) c.alter();
    });
    ensure(CREATED_BY_COLUMN, (alter) => {
      const c = table.string(CREATED_BY_COLUMN, CREATED_BY_LENGTH).nullable();
      if (alter) c.alter();
      else c.index();
    });
    ensure(VERSION_COLUMN, (alter) => {
      const c = table.integer(VERSION_COLUMN).notNullable().defaultTo(0);
      if (alter) c.alter();
    });
    ensure(AMENDED_FROM_COLUMN, (alter) => {
      const c = table.string(AMENDED_FROM_COLUMN, 255).nullable();
      if (alter) c.alter();
    });
  }

  #sqlTypeFamily(rawType) {
    const t = (rawType || "").toLowerCase();
    if (!t) return null;
    if (t.includes("int")) return "int";
    if (t.includes("char") || t.includes("text") || t.includes("string")) return "string";
    if (t.includes("decimal") || t.includes("numeric") || t.includes("money")) return "decimal";
    if (t.includes("float") || t.includes("real")) return "float";
    if (t.includes("double")) return "double";
    if (t.includes("bool")) return "bool";
    if (t.includes("timestamp") || (t.includes("date") && t.includes("time"))) return "datetime";
    if (t.includes("date")) return "date";
    if (t.includes("time")) return "time";
    if (t.includes("json")) return "json";
    if (t.includes("uuid")) return "uuid";
    if (t.includes("blob") || t.includes("bytea") || t.includes("binary")) return "blob";
    return null;
  }

  /**
   * An existing TEXT column on a field declared unique/index: MySQL/MariaDB
   * can't key it, so it's converted to VARCHAR before the key is added
   * (SQLite and Postgres key TEXT fine — left alone).
   */
  #keyedTextColumn(field, existingCol) {
    if (!this.isMySQLLike || !isKeyed(field)) return false;
    return /text/i.test(existingCol?.type || "");
  }

  /**
   * A field declared as TEXT whose column is still VARCHAR (same "string"
   * family, so the family check misses it): widen it. Keyed fields stay
   * VARCHAR on purpose (see isKeyed). SQLite doesn't enforce lengths.
   */
  #textOnVarcharColumn(field, existingCol) {
    if (this.isSQLiteLike || isKeyed(field)) return false;
    if (!TEXT_FORMATS.has(resolveColumnFormatKey(field))) return false;
    return /char/i.test(existingCol?.type || "");
  }

  /**
   * A fixed-precision field whose column holds fewer decimals or fewer whole
   * digits than it now declares (same "decimal" family, so the family check
   * misses it): `scale: 6` on a column created as (10,2) would keep rounding
   * to cents. Columns are only ever widened here, never narrowed. SQLite
   * doesn't enforce precision.
   */
  #decimalColumnTooNarrow(field, existingCol) {
    if (this.isSQLiteLike) return false;
    const defaults = DECIMAL_DEFAULTS[resolveColumnFormatKey(field)];
    if (!defaults || !Number.isFinite(existingCol?.scale) || !Number.isFinite(existingCol?.precision)) return false;
    const precision = Number(field.data?.precision) || defaults[0];
    const scale = Number(field.data?.scale) || defaults[1];
    return scale > existingCol.scale || precision - scale > existingCol.precision - existingCol.scale;
  }

  #columnTypeFamilyChanged(field, existingCol) {
    const family = (rawType) => {
      const t = (rawType || "").toLowerCase();
      if (!t) return null;
      if (t.includes("int")) return "int";
      if (t.includes("char") || t.includes("text") || t.includes("string")) return "string";
      if (t.includes("decimal") || t.includes("numeric") || t.includes("money")) return "decimal";
      if (t.includes("float") || t.includes("real")) return "float";
      if (t.includes("double") || t.includes("precision")) return "double";
      if (t.includes("bool")) return "bool";
      if (t.includes("date") && t.includes("time")) return "datetime";
      if (t.includes("timestamp")) return "datetime";
      if (t.includes("date")) return "date";
      if (t.includes("time")) return "time";
      if (t.includes("json")) return "json";
      if (t.includes("uuid")) return "uuid";
      if (t.includes("blob") || t.includes("bytea") || t.includes("binary")) return "blob";
      return null;
    };

    const existingFamily = family(existingCol.type);
    if (!existingFamily) return false;

    // int → long_int is the same family but a wider column: a 32-bit INTEGER
    // can't hold what the field now declares (epoch milliseconds, say).
    // SQLite's INTEGER is already 64-bit, so only server engines change.
    if (
      !this.isSQLiteLike &&
      resolveColumnFormat(field) === "long_int" &&
      existingFamily === "int" &&
      !/bigint/i.test(existingCol.type || "")
    ) return true;

    return !this.#sameColumnFamily(declaredColumnFamily(field), existingFamily);
  }

  /**
   * Whether a column of the `existing` family already is what the field
   * declares. Engines store some types as others: outside Postgres a UUID
   * is CHAR(36) and a boolean an integer (MySQL TINYINT(1)); JSON may be
   * TEXT (SQLite, MariaDB).
   */
  #sameColumnFamily(declared, existing) {
    if (declared === existing) return true;
    if (declared === "json" && existing === "string") return true;
    if (!this.isPostgresLike) {
      if (declared === "uuid" && existing === "string") return true;
      if (declared === "bool" && existing === "int") return true;
    }
    return false;
  }

  /**
   * Before text columns change to another type: empty texts become NULL
   * (they hold no value of the new type) and any value the new type can't
   * take stops the change with a message that says which — instead of the
   * engine's error halfway through the ALTER (Postgres, MySQL) or values of
   * the wrong type copied as they are (SQLite's table rebuild).
   */
  async #prepareRetype(literalName, changedFields) {
    const problems = [];

    for (const { field, existing } of changedFields) {
      const to = declaredColumnFamily(field);
      const check = CONVERTIBLE_TEXT[to];
      if (this.#sqlTypeFamily(existing.type) !== "string" || !check) continue;

      const col = field.data.name;
      const nullable = existing.nullable !== false;
      if (nullable) {
        await this.qx()(literalName).whereRaw("TRIM(??) = ?", [col, ""]).update({ [col]: null });
      }

      const rows = await this.qx()(literalName).distinct(col).whereNotNull(col).limit(RETYPE_SAMPLE);
      const bad = rows.map((row) => row[col]).filter((v) => !check(String(v).trim()));
      if (!bad.length) continue;

      const shown = bad.slice(0, 5).map((v) => `"${String(v).slice(0, 40)}"`).join(", ");
      const more = bad.length > 5 ? ` and ${bad.length - 5} more` : "";
      problems.push(`${field.data.label || col} (${col}) can't become ${resolveColumnFormatKey(field)}: ${shown}${more} ${bad.length === 1 ? "is" : "are"} not ${to === "int" ? "a whole number" : `a valid ${to}`}.`);
    }

    if (problems.length) {
      const err = new Error(`${problems.join("<br/>")}<br/>Fix or clear those values first, or keep the current format.`);
      err.status = 400;
      err.code = 400;
      err.title = "Can't change the column type";
      err.expose = true;
      throw err;
    }
  }

  async reconcileOrphanColumns(tableName, fields, existingFields) {
    const structureCols = new Set();
    const collect = (field) => {
      if (fieldHasColumn(field)) structureCols.add(field.data.name.toLowerCase());
      field.elements?.forEach(collect);
    };
    fields.forEach(collect);

    const IMMUNE = new Set(["id", "name", CHILD_POSITION_COLUMN, ...AUDIT_COLUMN_SET]);
    const orphans = existingFields.filter(
      f => !structureCols.has(f.name.toLowerCase()) && !IMMUNE.has(f.name.toLowerCase())
    );

    if (!orphans.length) return;

    /* console.log([
      `[reconcileOrphanColumns] ${orphans.length} orphan(s) in ${tableName}:`,
      orphans.map(o => o.name),
    ]); */

    await orphanManager.reconcile(this, tableName, orphans);
  }

  escapeId(identifier) { return escapeId(identifier, this.dialect); }

  /**
   * Read column metadata for a table. Returned shape: an array of
   * `{ name, type, nullable, default, primary }` per column, plus
   * `precision` and `scale` on fixed-precision ones (MySQL, Postgres). Used by
   * orphan-manager and the install/update flow.
   */
  async getTableDescription(document) {
    let raw, mapFn;

    try {
      if (this.isSQLiteLike) {
        raw   = await this.qx().raw(`PRAGMA table_info('${document}')`);
        mapFn = r => ({ name: r.name, type: r.type, nullable: !r.notnull, default: r.dflt_value, primary: r.pk === 1 });
      } else if (this.isMySQLLike) {
        // DESCRIBE works the same on MySQL and MariaDB. Column shape:
        // { Field, Type, Null, Key, Default, Extra }
        raw   = await this.qx().raw(`DESCRIBE \`${document}\``);
        mapFn = r => {
          // "decimal(10,2)": the shape of a fixed-precision column.
          const shape = /^(?:decimal|numeric)\((\d+),(\d+)\)/i.exec(r.Type || "");
          return {
            name: r.Field, type: r.Type, nullable: r.Null === "YES", default: r.Default, primary: r.Key === "PRI",
            ...(shape ? { precision: Number(shape[1]), scale: Number(shape[2]) } : {}),
          };
        };
      } else if (this.isPostgresLike) {
        // current_schema() exists on PG/Cockroach/Redshift. We scope by it
        // to avoid picking up rows from other schemas in shared deployments.
        raw   = await this.qx().raw(
          `SELECT column_name, data_type, is_nullable, column_default, numeric_precision, numeric_scale
             FROM information_schema.columns
             WHERE table_schema = current_schema() AND table_name = ?`, [document]
        );
        mapFn = r => ({
          name: r.column_name, type: r.data_type, nullable: r.is_nullable === "YES", default: r.column_default, primary: false,
          // The shape of a fixed-precision column (null for `numeric` without one).
          ...(r.data_type === "numeric" && r.numeric_scale != null ? { precision: Number(r.numeric_precision), scale: Number(r.numeric_scale) } : {}),
        });
      } else {
        // MSSQL / Oracle / unknown — best-effort generic information_schema.
        raw   = await this.qx().raw(
          `SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT
             FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = ?`, [document]
        );
        mapFn = r => ({
          name: r.COLUMN_NAME ?? r.column_name,
          type: r.DATA_TYPE   ?? r.data_type,
          nullable: (r.IS_NULLABLE ?? r.is_nullable) === "YES",
          default:  r.COLUMN_DEFAULT ?? r.column_default,
          primary: false,
        });
      }

      return this.unwrapRawRows(raw)
        .map(mapFn)
        .filter(c => c && c.name);   // defensive: some drivers return tail metadata rows
    } catch (e) {
      console.error(`Error getting table description for ${document}:`, e.message);
      return [];
    }
  }

  escape(value) {
    if (value === null || value === undefined)  return "NULL";
    if (Array.isArray(value) && !value.length) return "NULL";
    if (
      typeof value === "string"  || typeof value === "number" ||
      typeof value === "boolean" || value instanceof Date     ||
      (Array.isArray(value) && value.length)
    ) {
      const sql = this.knex.raw("?", [value]).toQuery();
      return sql;
    }
    return "NULL";
  }

  unwrapRawRows(raw) {
    if (Array.isArray(raw)) {
      return Array.isArray(raw[0]) ? raw[0] : raw;
    }
    return raw?.rows ?? [];
  }

  async raw(query, replacements = []) {
    const result = await this.qx().raw(query, replacements);
    return this.unwrapRawRows(result);
  }

  tableName(document, likeParam = false) {
    return likeParam ? this.escape(document) : this.escapeId(document);
  }

  /**
   * Short form of `tableName` for use inside raw SQL strings — also handles
   * a column on the same call. Always returns a dialect-correctly-quoted
   * identifier so the returned value can be interpolated directly:
   *
   *   t('User') =>  `User` (or "User" on Postgres)
   *   t('User', 'name') => `User`.`name`
   *   t('User', '*') =>  `User`.* (no quotes on `*`)
   *   t('Page View', 'id') => `Page View`.`id`
   *
   * Use this for raw SQL only. Knex's query builder (`knex(table)`,
   * `.from(table)`, `.where(col, ...)`) already quotes identifiers itself.
   */
  t(table, col) {
    const tbl = this.tableName(table);
    if (col == null) return tbl;
    if (col === "*") return `${tbl}.*`;
    return `${tbl}.${this.escapeId(col)}`;
  }

  async close() {
    if (this._coreConnection) { await this._coreConnection.destroy(); this._coreConnection = null; }
    if (this.knex) { await this.knex.destroy(); this.knex = null; }
  }
}
