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
  isAuditableEntity,
  addAuditColumns,
  addPrimaryKey,
  COLUMN_FORMATS,
} from "loopar";

import { orphanManager } from "./orphan-manager.js";

export function resolveColumnSqlBuilder(field) {
  // data.format / data.type
  const fmt = resolveColumnFormat(field);
  if (fmt && COLUMN_FORMATS[fmt]) return COLUMN_FORMATS[fmt].sql;

  // element default → legacy tag
  const tag = elementsDict[field?.element]?.def?.type;
  if (tag && LEGACY_TAG_TO_FORMAT.has(tag)) {
    const key = LEGACY_TAG_TO_FORMAT.get(tag);
    if (COLUMN_FORMATS[key]) return COLUMN_FORMATS[key].sql;
  }

  // default — VARCHAR(255)
  return COLUMN_FORMATS.data.sql;
}

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

  constructor(config = null) {
    this.customConfig = config;
    this.transactionStack = [];
  }

  get dbConfig() { return loopar.getDbConfig(); }
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

  async beginTransaction() {
    if (this.transaction) throw new Error("Transaction already active");
    this.transaction = await this.knex.transaction();
    return this.transaction;
  }

  async safeRollback() {
    if (!this.transaction) return;
    try   { await this.transaction.rollback(); }
    catch (e) { console.error("Rollback failed:", e.message); }
    finally   { this.transaction = null; }
  }

  async endTransaction() {
    if (!this.transaction) return;
    try   { await this.transaction.commit(); }
    catch (e) { console.error("Commit failed:", e.message); await this.safeRollback(); throw e; }
    finally   { this.transaction = null; }
  }

  async rollbackTransaction() { await this.safeRollback(); }

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

    await this.qx().schema.createTable(literalName, (table) => {
      // utf8mb4 + InnoDB only matter on MySQL/MariaDB; Knex no-ops them elsewhere.
      if (this.isMySQLLike) {
        table.charset("utf8mb4");
        table.collate("utf8mb4_unicode_ci");
        table.engine("InnoDB");
      }

      addPrimaryKey(table);

      const process = (field) => {
        if (fieldIsWritable(field)) {
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
    });
  }

  #isFrameworkColumn(name, auditable) {
    if (!name) return false;
    const lower = name.toLowerCase();
    if (lower === "id") return true;
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
      if (fieldIsWritable(field)) {
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
          } else if (this.#columnTypeFamilyChanged(field, existing)) {
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

    if (!newFields.length && !changedFields.length && !addAudit) return;

    for (const { field, existing } of changedFields) {
      const declared = resolveColumnFormat(field) || elementsDict[field.element]?.def?.type || "data";
      const note = this.isSQLiteLike ? " (SQLite: emulated via table-rebuild)" : "";
      console.log([
        `[alterTable] ${literalName}.${field.data.name}: type change`,
        `${existing.type} → ${declared}${note}`,
      ]);
    }

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

    for (const colName of ensureUnique) {
      try {
        await this.qx().schema.alterTable(literalName, (t) => {
          t.unique(colName);
        });
        console.log([`[alterTable] ${literalName}.${colName}: UNIQUE constraint added`]);
      } catch (e) {
        const msg = (e?.message || "").toLowerCase();
        if (
          !(msg.includes("already exists") ||
          msg.includes("duplicate key name") ||
          msg.includes("duplicate") && msg.includes("key"))
        ) {
          console.error(
            `[alterTable] ${literalName}.${colName}: failed to add UNIQUE — ${e.message}`
          );
        }
      }
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

    try {
      await this.qx().schema.alterTable(literalName, (t) => t.dropUnique(["module", "name"]));
      console.log([`[name-identity] ${literalName}: UNIQUE(module, name) dropped`]);
    } catch (e) {
      if (!missing(e)) throw e;
    }

    try {
      await this.qx().schema.alterTable(literalName, (t) => t.unique(["name"]));
    } catch (e) {
      if (!present(e)) throw e;
    }
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

    const FORMAT_FAMILY = {
      data: "string", email: "string", password: "string",
      text: "string", mediumtext: "string", longtext: "string",
      int: "int", long_int: "int",
      float: "float", double: "double",
      decimal: "decimal", currency: "decimal",
      date: "date", datetime: "datetime", time: "time",
      boolean: "bool", json: "json", jsonb: "json",
      uuid: "uuid", blob: "blob",
    };

    let declaredFamily = null;
    const fmt = resolveColumnFormat(field);
    if (fmt && FORMAT_FAMILY[fmt]) {
      declaredFamily = FORMAT_FAMILY[fmt];
    } else {
      const tag = elementsDict[field.element]?.def?.type;
      if (tag) {
        const fmtFromTag = LEGACY_TAG_TO_FORMAT.get(tag);
        if (fmtFromTag && FORMAT_FAMILY[fmtFromTag]) {
          declaredFamily = FORMAT_FAMILY[fmtFromTag];
        }
      }
    }
    if (!declaredFamily) declaredFamily = "string";

    return declaredFamily !== existingFamily;
  }

  async reconcileOrphanColumns(tableName, fields, existingFields) {
    const structureCols = new Set();
    const collect = (field) => {
      if (fieldIsWritable(field)) structureCols.add(field.data.name.toLowerCase());
      field.elements?.forEach(collect);
    };
    fields.forEach(collect);

    const IMMUNE = new Set(["id", "name", ...AUDIT_COLUMN_SET]);
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
   * `{ name, type, nullable, default, primary }` per column. Used by
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
        mapFn = r => ({ name: r.Field, type: r.Type, nullable: r.Null === "YES", default: r.Default, primary: r.Key === "PRI" });
      } else if (this.isPostgresLike) {
        // current_schema() exists on PG/Cockroach/Redshift. We scope by it
        // to avoid picking up rows from other schemas in shared deployments.
        raw   = await this.qx().raw(
          `SELECT column_name, data_type, is_nullable, column_default
             FROM information_schema.columns
             WHERE table_schema = current_schema() AND table_name = ?`, [document]
        );
        mapFn = r => ({ name: r.column_name, type: r.data_type, nullable: r.is_nullable === "YES", default: r.column_default, primary: false });
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
