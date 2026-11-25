'use strict';

/**
 * Moves a tenant's database to another engine (e.g. SQLite → PostgreSQL).
 *
 *   1. Structure: every table of the tenant is built on the target. Entity
 *      tables go through the same path Entity.save takes on install
 *      (normalizeFields → makeTable with the entity's meta), so the target
 *      gets the native columns, keys and framework columns a fresh install
 *      would create there. A table without an entity (or a column the entity
 *      no longer declares) is rebuilt from the source columns, so nothing is
 *      left behind.
 *   2. Records: copied table by table, as they are (ids, names, audit
 *      columns), each value converted to the type of its target column.
 *      Values the target can't take are reported, never truncated or dropped.
 *   3. Sequences are moved past the copied ids, and every table is counted
 *      on both sides.
 *
 * Records are copied after the whole structure exists, not while each table
 * is created, and the foreign keys are added once every record is in: the
 * order of the data doesn't matter.
 *
 * Runs inside the tenant's request context (`loopar` is the tenant). The
 * source database is never written. On failure, or in a test run, whatever
 * was created on the target is dropped.
 */

import crypto from 'node:crypto';
import { KnexORM } from 'db-env';
import { loopar } from '../loopar.js';
import { fileManage } from '../file-manage.js';
import { coerceDocStatus } from '../global/audit.js';
import { syncForeignKeys, dropForeignKeys } from '../document/foreign-keys.js';

/** Engines a tenant can be moved to. */
export const MIGRATION_TARGETS = ['postgres', 'mysql', 'mariadb'];

const MAX_ISSUES = 200;
const MAX_PARAMS = 20_000;   // bind parameters per INSERT (PG caps at 65535)
const READ_BATCH = 1_000;

const family = (dialect) => {
  const d = String(dialect || '').toLowerCase();
  if (/sqlite/.test(d)) return 'sqlite';
  if (/mysql|mariadb/.test(d)) return 'mysql';
  if (/postgres|cockroach|redshift/.test(d)) return 'postgres';
  return d;
};

const migrationError = (message, extra = {}) => Object.assign(new Error(message), extra);

/* ------------------------------------------------------------------ tables */

async function listTables(orm) {
  const f = family(orm.dialect);
  const sql = f === 'sqlite'
    ? "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
    : f === 'mysql'
      ? "SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'"
      : "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'";
  const rows = await orm.raw(sql);
  return rows.map((r) => r.name ?? r.NAME ?? r.TABLE_NAME).filter(Boolean).sort();
}

/** Target columns with what the copy needs to convert values: type, length, nullability, default. */
async function targetColumns(orm, table) {
  const scope = family(orm.dialect) === 'mysql' ? 'DATABASE()' : 'current_schema()';
  const rows = await orm.raw(
    `SELECT column_name, data_type, is_nullable, character_maximum_length, column_default
       FROM information_schema.columns WHERE table_schema = ${scope} AND table_name = ?`,
    [table],
  );
  const pick = (r, k) => r[k] ?? r[k.toUpperCase()];
  return rows.map((r) => ({
    name: pick(r, 'column_name'),
    type: String(pick(r, 'data_type') || '').toLowerCase(),
    nullable: String(pick(r, 'is_nullable')).toUpperCase() === 'YES',
    maxLength: Number(pick(r, 'character_maximum_length')) || null,
    hasDefault: pick(r, 'column_default') != null,
  }));
}

/* ----------------------------------------------------------- structure */

/** Knex column for a source column type, for tables/columns no entity describes. */
function addGenericColumn(table, column) {
  const t = String(column.type || '').toLowerCase();
  const name = column.name;
  if (name === 'id' && column.primary) return table.increments('id');

  let size;
  if (/bool/.test(t)) return table.boolean(name);
  if (/bigint/.test(t)) return table.bigInteger(name);
  if (/int/.test(t)) return table.integer(name);
  if ((size = t.match(/(?:decimal|numeric)\s*\((\d+)\s*,\s*(\d+)\)/))) return table.decimal(name, +size[1], +size[2]);
  if (/decimal|numeric|real|float|double/.test(t)) return table.double(name);
  if (/datetime|timestamp/.test(t)) return table.datetime(name);
  if (/^date$/.test(t)) return table.date(name);
  if (/^time/.test(t)) return table.time(name);
  if (/json/.test(t)) return table.json(name);
  if (/blob|binary|bytea/.test(t)) return table.binary(name);
  if ((size = t.match(/char[a-z ]*\((\d+)\)/))) return table.string(name, +size[1]);
  return table.text(name);
}

/**
 * The entity document behind a table, ready for makeTable — or null when the
 * table isn't an entity table (no ref, single/virtual entity, or a record
 * that can't be loaded).
 */
async function entityFor(table, warn) {
  const ref = loopar.getRef(table, false);
  if (!ref || ref.is_single || ref.is_virtual) return null;
  try {
    const doc = await loopar.getDocument(ref.__ENTITY__ || 'Entity', ref.__NAME__ || table, null, { ifNotFound: null });
    if (!doc || typeof doc.isDBEntity !== 'function' || !doc.isDBEntity()) return null;
    await doc.normalizeFields();
    return doc;
  } catch (e) {
    warn(`${table}: built from its source columns (its entity could not be loaded: ${e.message})`);
    return null;
  }
}

async function buildStructure({ source, target, tables, created, onStep, warn }) {
  const generic = [];
  for (const [i, table] of tables.entries()) {
    onStep(`structure ${i + 1}/${tables.length}`);
    const sourceCols = await source.getTableDescription(table);
    const doc = await entityFor(table, warn);

    if (doc) {
      // The same call Entity.save makes on install.
      await target.makeTable(table, doc.doc_structure, {
        entityMeta: {
          name: doc.name,
          is_static: 0,
          is_child: doc.is_child,
          is_single: 0,
          is_audited: doc.is_audited,
        },
      });
    } else {
      generic.push(table);
      await target.knex.schema.createTable(table, (t) => {
        for (const col of sourceCols) addGenericColumn(t, col);
      });
    }
    created.push(table);

    // Columns the source has and the entity no longer declares (released
    // orphans, old fields): kept, so no value is lost.
    const have = new Set((await targetColumns(target, table)).map((c) => c.name.toLowerCase()));
    const missing = sourceCols.filter((c) => !have.has(c.name.toLowerCase()));
    if (missing.length) {
      await target.knex.schema.alterTable(table, (t) => {
        for (const col of missing) addGenericColumn(t, { ...col, primary: false });
      });
      warn(`${table}: kept ${missing.length} column(s) its entity doesn't declare (${missing.map((c) => c.name).join(', ')})`);
    }
    target.invalidateColumnsCache?.(table);
  }
  return generic;
}

/* -------------------------------------------------------------- values */

const INT_TYPES = /^(integer|int|bigint|smallint|tinyint|mediumint)$/;
const NUM_TYPES = /^(numeric|decimal|real|double precision|double|float)$/;
const DATETIME_TYPES = /^(timestamp|timestamp with time zone|timestamp without time zone|datetime)$/;
const TIME_TYPES = /^(time|time with time zone|time without time zone)$/;
const BINARY_TYPES = /^(bytea|blob|tinyblob|mediumblob|longblob|binary|varbinary)$/;
const TRUE_WORDS = new Set(['1', 'true', 't', 'yes', 'y', 'on']);
const FALSE_WORDS = new Set(['0', 'false', 'f', 'no', 'n', 'off']);

/** Largest value of the integer types narrower than SQLite's (64-bit) INTEGER. */
const INT_MAX = { integer: 2147483647, int: 2147483647, mediumint: 8388607, smallint: 32767 };

const isTextType = (t) => !INT_TYPES.test(t) && !NUM_TYPES.test(t) && t !== 'boolean' && t !== 'date'
  && !DATETIME_TYPES.test(t) && !TIME_TYPES.test(t) && !/^jsonb?$/.test(t) && !BINARY_TYPES.test(t);

class Invalid extends Error {}
const invalid = (why) => { throw new Invalid(why); };

/** Dates stored as numbers (Knex on SQLite writes Date objects as epoch milliseconds). */
const fromEpoch = (n) => new Date(Math.abs(n) < 1e11 ? n * 1000 : n);

/**
 * `value` converted to what `col` accepts. Throws Invalid when it can't be
 * done without changing the data. An empty string in a non-text column is
 * the "no value" SQLite let through: it becomes NULL.
 */
export function convertValue(value, col) {
  if (value === null || value === undefined) return null;
  const t = col.type;
  const isText = isTextType(t);

  if (Buffer.isBuffer(value)) {
    if (BINARY_TYPES.test(t)) return value;
    value = value.toString('utf8');
  }
  const str = typeof value === 'string' ? value.trim() : null;
  if (str === '' && !isText) return null;

  if (INT_TYPES.test(t)) {
    let n;
    if (typeof value === 'boolean') n = value ? 1 : 0;
    else if (typeof value === 'number') n = Number.isInteger(value) ? value : invalid('not an integer');
    else if (/^[-+]?\d+(\.0+)?$/.test(str)) n = parseInt(str, 10);
    else if (TRUE_WORDS.has(str.toLowerCase()) && t === 'tinyint') n = 1;
    else if (FALSE_WORDS.has(str.toLowerCase()) && t === 'tinyint') n = 0;
    else return invalid('not an integer');
    const max = INT_MAX[t];
    if (max && Math.abs(n) > max) invalid(`out of range for ${t}`);
    return n;
  }
  if (NUM_TYPES.test(t)) {
    if (typeof value === 'boolean') return value ? 1 : 0;
    const n = typeof value === 'number' ? value : Number(str);
    return Number.isFinite(n) ? n : invalid('not a number');
  }
  if (t === 'boolean') {
    if (typeof value === 'boolean') return value;
    const s = String(value).trim().toLowerCase();
    if (TRUE_WORDS.has(s)) return true;
    if (FALSE_WORDS.has(s)) return false;
    return invalid('not a yes/no value');
  }
  if (t === 'date' || DATETIME_TYPES.test(t)) {
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? invalid('not a date') : value;
    if (typeof value === 'number') return fromEpoch(value);
    if (/^-?\d{10,}$/.test(str)) return fromEpoch(Number(str));
    if (/^0000-00-00/.test(str)) return null;   // MySQL's "zero date": no date
    if (!/^\d{4}-\d{2}-\d{2}/.test(str) || Number.isNaN(Date.parse(str.replace(' ', 'T')))) return invalid('not a date');
    return t === 'date' ? str.slice(0, 10) : str;
  }
  if (TIME_TYPES.test(t)) {
    return /^\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(str) ? str : invalid('not a time');
  }
  if (/^jsonb?$/.test(t)) {
    if (typeof value === 'object') return JSON.stringify(value);
    try { JSON.parse(str); return str; } catch { return invalid('not valid JSON'); }
  }
  if (BINARY_TYPES.test(t)) return Buffer.from(String(value));

  // Text
  let text = value instanceof Date ? value.toISOString() : typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (col.maxLength && text.length > col.maxLength) invalid(`${text.length} characters, the column takes ${col.maxLength}`);
  return text;
}

/* ---------------------------------------------------------------- copy */

const sample = (v) => {
  const s = Buffer.isBuffer(v) ? `<${v.length} bytes>` : String(v);
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
};

const DOC_STATUS = '__document_status__';

async function copyTable({ source, target, table, onStep, issues, warn }) {
  const cols = await targetColumns(target, table);
  const byName = new Map(cols.map((c) => [c.name.toLowerCase(), c]));
  // Columns the target has and the source doesn't (framework columns a fresh
  // install adds, e.g. __version__) get no values: nothing to look at there.
  const inSource = new Set((await source.getTableDescription(table)).map((c) => c.name.toLowerCase()));
  const total = Number((await source.knex(table).count({ n: '*' }))[0]?.n ?? 0);
  const perInsert = Math.max(1, Math.min(500, Math.floor(MAX_PARAMS / Math.max(1, cols.length))));
  const hasId = byName.has('id');
  const order = (q) => hasId ? q.orderBy('id')
    : family(source.dialect) === 'sqlite' ? q.orderByRaw('rowid') : q;

  const tableIssues = [];
  const report = (issue) => {
    tableIssues.push(issue);
    if (issues.length < MAX_ISSUES) issues.push(issue);
  };

  // A required column the source holds empty values in: on the source it is
  // nullable (columns added to an existing table are), so it is on the
  // target too — the values stay as they are, `required` is still enforced
  // on save.
  for (const col of cols) {
    if (col.nullable || col.hasDefault || col.name.toLowerCase() === 'id') continue;
    let n = total;   // a column the source doesn't have: every record arrives without it
    if (inSource.has(col.name.toLowerCase())) {
      const q = source.knex(table).whereNull(col.name);
      if (!isTextType(col.type)) q.orWhere(col.name, '');
      n = Number((await q.count({ n: '*' }))[0]?.n ?? 0);
    }
    if (!n) continue;
    await target.knex.schema.alterTable(table, (t) => t.setNullable(col.name));
    col.nullable = true;
    warn(`${table}.${col.name}: required, but ${n} record(s) have no value — left nullable, as in the source`);
  }

  // SQLite's INTEGER is 64-bit: a narrower target column whose source holds
  // bigger numbers (epoch milliseconds, say) is widened to BIGINT.
  for (const col of cols) {
    const max = INT_MAX[col.type];
    if (!max || col.name.toLowerCase() === 'id' || !inSource.has(col.name.toLowerCase())) continue;
    const [r] = await source.knex(table).max({ hi: col.name }).min({ lo: col.name });
    const extreme = Math.max(Math.abs(Number(r?.hi) || 0), Math.abs(Number(r?.lo) || 0));
    if (extreme <= max) continue;
    if (family(target.dialect) === 'postgres') {
      await target.knex.raw('ALTER TABLE ?? ALTER COLUMN ?? TYPE bigint', [table, col.name]);
    } else {
      await target.knex.raw(`ALTER TABLE ?? MODIFY ?? BIGINT ${col.nullable ? 'NULL' : 'NOT NULL'}`, [table, col.name]);
    }
    col.type = 'bigint';
    warn(`${table}.${col.name}: holds numbers up to ${extreme} — created as BIGINT, as SQLite stores them; consider format "long_int" in its entity`);
  }

  // Legacy values the framework itself reads leniently.
  const fixed = new Map();   // column → how many values were normalized
  const normalize = (col, value) => {
    if (typeof value !== 'string' || isTextType(col.type)) return value;
    let v = value.trim();
    // Quoted literals ('1', '2023-11-23…') written by an old escaping bug.
    if (/^'.*'$/s.test(v)) v = v.slice(1, -1).trim();
    // __document_status__ held names ("Active") before it became a number.
    if (col.name === DOC_STATUS && INT_TYPES.test(col.type) && !/^\d+$/.test(v)) v = coerceDocStatus(v);
    if (v !== value) fixed.set(col.name, (fixed.get(col.name) || 0) + 1);
    return v;
  };

  let copied = 0;
  await target.knex.transaction(async (trx) => {
    for (let offset = 0; offset < total; offset += READ_BATCH) {
      const rows = await order(source.knex(table).select('*')).limit(READ_BATCH).offset(offset);
      const out = [];
      for (const row of rows) {
        const record = {};
        for (const [key, value] of Object.entries(row)) {
          const col = byName.get(key.toLowerCase());
          if (!col) continue;
          try {
            const v = convertValue(normalize(col, value), col);
            if (v === null && !col.nullable) {
              if (col.hasDefault) continue;   // let the column default fill it
              throw new Invalid('empty, the column requires a value');
            }
            record[col.name] = v;
          } catch (e) {
            if (!(e instanceof Invalid)) throw e;
            report({ table, column: col.name, row: row.name ?? row.id ?? null, value: sample(value), problem: e.message });
          }
        }
        out.push(record);
      }
      if (!tableIssues.length) {
        for (let i = 0; i < out.length; i += perInsert) await trx(table).insert(out.slice(i, i + perInsert));
      }
      copied += rows.length;
      onStep(`records ${table} ${copied}/${total}`);
    }
    // A table with values the target can't take isn't written (the whole
    // migration fails); the scan above still lists all of its problems.
    if (tableIssues.length) throw new Invalid('rejected values');
  }).catch((e) => { if (!(e instanceof Invalid)) throw e; });

  for (const [column, n] of fixed) {
    warn(column === DOC_STATUS
      ? `${table}.${column}: ${n} legacy status value(s) stored as their number`
      : `${table}.${column}: ${n} value(s) unquoted ('…' → …)`);
  }

  return { table, rows: total, problems: tableIssues.length };
}

/**
 * Moves the `id` counter past the copied ids: the records were inserted with
 * their own ids, which a Postgres sequence doesn't see (MySQL's
 * AUTO_INCREMENT follows inserts by itself).
 */
async function resetSequences(target, table) {
  if (family(target.dialect) !== 'postgres') return;
  const quoted = `"${table.replaceAll('"', '""')}"`;
  const [row] = target.unwrapRawRows(await target.knex.raw('SELECT pg_get_serial_sequence(?, ?) AS seq', [quoted, 'id']));
  if (!row?.seq) return;
  await target.knex.raw(
    'SELECT setval(?::regclass, COALESCE((SELECT MAX(??) FROM ??), 0) + 1, false)',
    [row.seq, 'id', table],
  );
}

/* --------------------------------------------------------------- target */

async function databaseExists(orm) {
  const f = family(orm.dialect);
  const sql = f === 'postgres'
    ? 'SELECT 1 FROM pg_database WHERE datname = ?'
    : 'SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?';
  const rows = orm.unwrapRawRows(await orm.coreConnection.raw(sql, [orm.database]));
  return rows.length > 0;
}

const sameDatabase = (a, b) => {
  if (family(a.dialect) !== family(b.dialect)) return false;
  const ca = a.connection || {}, cb = b.connection || {};
  return String(ca.host || 'localhost') === String(cb.host || 'localhost')
    && String(ca.port || '') === String(cb.port || '')
    && String(a.database || '') === String(b.database || '');
};

/**
 * The db.config a migration writes: engine, server connection and database.
 * `database` is generated (db_<16 hex>, like a new install) when not given.
 */
export function targetConfig({ dialect, connection = {}, database } = {}) {
  dialect = String(dialect || '').toLowerCase();
  if (!MIGRATION_TARGETS.includes(dialect)) {
    throw migrationError(`A tenant can be moved to ${MIGRATION_TARGETS.join(', ')} — not "${dialect || '?'}".`, { status: 400 });
  }
  database = String(database || '').trim()
    || `db_${crypto.randomBytes(8).toString('hex')}`;
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(database)) {
    throw migrationError(`Invalid database name "${database}": letters, numbers and "_", not starting with a number.`, { status: 400 });
  }
  return { dialect, connection: { ...connection }, database };
}

/* ----------------------------------------------------------------- run */

/**
 * Copy the current tenant's database into `target` ({ dialect, connection,
 * database }). With `test` the copy is made, checked and dropped again: the
 * tenant keeps its database and nothing changes. Otherwise the tenant's
 * db.config points to the target when it ends (the previous one is kept as
 * db.config.previous.json); the caller re-initializes the tenant.
 */
export async function migrateDatabase({ target: targetCfg, test = false, onStep = () => {} } = {}) {
  const source = loopar.db;
  const sourceCfg = structuredClone(loopar.getDbConfig() || {});
  const cfg = targetConfig(targetCfg);

  if (!loopar.__installed__) throw migrationError('Only an installed, up-to-date tenant can be migrated: open it once so it runs its pending update.', { status: 409 });
  if (sameDatabase(sourceCfg, cfg)) throw migrationError('The target is the database the tenant already uses.', { status: 400 });

  const warnings = [];
  const issues = [];
  const warn = (w) => warnings.push(w);
  const target = new KnexORM(cfg);
  let createdDatabase = false;
  const createdTables = [];

  const cleanUp = async () => {
    try {
      if (createdDatabase) {
        await target.knex?.destroy().catch(() => {});
        target.knex = null;
        await target.dropSchema(cfg.database);
      } else {
        await dropForeignKeys(target).catch(() => {});
        for (const table of createdTables.reverse()) await target.knex.schema.dropTableIfExists(table);
      }
    } catch (e) {
      warn(`The target could not be cleaned up: ${e.message}`);
    }
  };

  try {
    onStep('connecting');
    try {
      createdDatabase = !(await databaseExists(target));
      await target.alterSchema();
    } catch (e) {
      throw migrationError(`Could not reach the target server: ${e.message}`, { status: 503 });
    }
    await target.initialize();
    if (!target.knex) throw migrationError('Could not connect to the target database.', { status: 503 });

    if (!createdDatabase && (await listTables(target)).length) {
      throw migrationError(`The database "${cfg.database}" already has tables. Use an empty database.`, { status: 409 });
    }

    const tables = await listTables(source);

    // 1. Structure, all of it before any record.
    const generic = await buildStructure({ source, target, tables, created: createdTables, onStep, warn });

    // 2. Records.
    const counts = [];
    for (const [i, table] of tables.entries()) {
      onStep(`records ${i + 1}/${tables.length} ${table}`);
      counts.push(await copyTable({ source, target, table, onStep, issues, warn }));
    }
    const rejected = counts.filter((c) => c.problems);
    if (rejected.length) {
      throw migrationError(
        `${rejected.reduce((n, c) => n + c.problems, 0)} value(s) in ${rejected.length} table(s) can't be stored in ${cfg.dialect}. Fix them in the current database and try again.`,
        { status: 422, issues },
      );
    }

    // 3. Counters and check.
    onStep('verify');
    for (const table of tables) {
      await resetSequences(target, table);
      const n = Number((await target.knex(table).count({ n: '*' }))[0]?.n ?? 0);
      const expected = counts.find((c) => c.table === table).rows;
      if (n !== expected) throw migrationError(`${table}: ${n} records on the target, ${expected} in the source.`);
    }

    // 4. Foreign keys, once every record is in (core/document/foreign-keys.js).
    onStep('foreign keys');
    const keys = await syncForeignKeys(target);
    for (const issue of keys.issues) warn(`Foreign key ${issue.name} not created: ${issue.problem}`);

    const result = {
      test,
      from: sourceCfg.dialect,
      to: cfg.dialect,
      database: cfg.database,
      tables: tables.length,
      records: counts.reduce((n, c) => n + c.rows, 0),
      foreignKeys: keys.created.length,
      rebuiltFromSource: generic,
      warnings,
    };

    if (test) {
      await cleanUp();
      return result;
    }

    await target.close();
    await fileManage.setConfigFile('db.config.previous', sourceCfg);
    await loopar.setDbConfig(cfg);
    return result;
  } catch (e) {
    await cleanUp();
    if (!e.issues && issues.length) e.issues = issues;
    e.warnings = warnings;
    throw e;
  } finally {
    await target.close().catch(() => {});
  }
}
