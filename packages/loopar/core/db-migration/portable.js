'use strict';

/**
 * Loopar's own, engine-independent database format, and the two ends a copy
 * of a tenant's database reads from (core/db-migration/migrate.js):
 *
 *   - liveSource(orm): a database the tenant can reach (migrating to another
 *     engine reads the tenant's own database through it);
 *   - fileSource(dir): a database exported with exportDatabase (restoring a
 *     backup in this format is a migration whose source is the file).
 *
 * The format (a folder, inside the backup archive):
 *
 *   schema.json   { format, version, dialect, exportedAt, tables: [{ name,
 *                   file, rows, columns: [{ name, type, nullable, primary }],
 *                   stats: { <column>: { nulls, empties, extreme } } }] }
 *   t<N>.ndjson   one record per line, in the table's `id` order. Values a
 *                 line of JSON can't hold as they are: { $b64 } (binary),
 *                 { $date } (a Date the driver returned).
 *
 * The stats answer what the copy asks a source before writing (how many
 * records leave a required column empty, the largest number in an integer
 * column) without reading the table twice.
 *
 * Only Knex: no dump tool has to be installed, and the file restores on any
 * engine Loopar runs on.
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

export const PORTABLE_FORMAT = 'loopar-db';
export const PORTABLE_VERSION = 1;
const READ_BATCH = 1_000;

export const family = (dialect) => {
  const d = String(dialect || '').toLowerCase();
  if (/sqlite/.test(d)) return 'sqlite';
  if (/mysql|mariadb/.test(d)) return 'mysql';
  if (/postgres|cockroach|redshift|^pg$/.test(d)) return 'postgres';
  return d;
};

const rowsOf = (result) => Array.isArray(result) ? (Array.isArray(result[0]) ? result[0] : result) : (result?.rows ?? []);

/** Base tables of a database, sorted (`q`: a Knex instance or transaction). */
export async function tablesOf(q, dialect) {
  const f = family(dialect);
  const sql = f === 'sqlite'
    ? "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
    : f === 'mysql'
      ? "SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'"
      : "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'";
  return rowsOf(await q.raw(sql)).map((r) => r.name ?? r.NAME ?? r.TABLE_NAME).filter(Boolean).sort();
}

/** Columns of a table as the copy describes them: { name, type, nullable, primary }. */
async function columnsOf(q, table) {
  const info = await q(table).columnInfo();
  return Object.entries(info).map(([name, c]) => {
    const type = String(c.type || '').toLowerCase();
    return {
      name,
      type: c.maxLength && /char/.test(type) && !/\(/.test(type) ? `${type}(${c.maxLength})` : type,
      nullable: c.nullable !== false,
      primary: name === 'id',
    };
  });
}

const isEmptyText = (v) => typeof v === 'string' && v.trim() === '';

const encode = (row) => {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = Buffer.isBuffer(v) ? { $b64: v.toString('base64') }
      : v instanceof Date ? { $date: Number.isNaN(v.getTime()) ? null : v.toISOString() }
      : v;
  }
  return out;
};

const decode = (row) => {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (v && typeof v === 'object' && '$b64' in v) out[k] = Buffer.from(v.$b64, 'base64');
    else if (v && typeof v === 'object' && '$date' in v) out[k] = v.$date === null ? null : new Date(v.$date);
    else out[k] = v;
  }
  return out;
};

/**
 * Export a database into `dir` in Loopar's format. All tables are read in
 * one read-only transaction: the export is one consistent picture even while
 * the tenant keeps working.
 * @returns {Promise<{ tables: number, rows: number }>}
 */
export async function exportDatabase(knex, dialect, dir, { onStep = () => {} } = {}) {
  await fs.promises.mkdir(dir, { recursive: true });
  const f = family(dialect);
  const schema = { format: PORTABLE_FORMAT, version: PORTABLE_VERSION, dialect: f, exportedAt: new Date().toISOString(), tables: [] };
  let total = 0;

  await knex.transaction(async (trx) => {
    // The first statement fixes the picture every later read sees.
    if (f === 'postgres') await trx.raw('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');

    const tables = await tablesOf(trx, f);
    for (const [i, table] of tables.entries()) {
      onStep(`export ${i + 1}/${tables.length} ${table}`);
      const columns = await columnsOf(trx, table);
      const hasId = columns.some((c) => c.name === 'id');
      const stats = Object.fromEntries(columns.map((c) => [c.name, { nulls: 0, empties: 0, extreme: 0 }]));
      const file = `t${i}.ndjson`;
      const out = fs.createWriteStream(path.join(dir, file));
      const write = (line) => new Promise((resolve) => { if (out.write(line)) resolve(); else out.once('drain', resolve); });

      let rows = 0;
      try {
        for (let offset = 0; ; offset += READ_BATCH) {
          let q = trx(table).select('*');
          if (hasId) q = q.orderBy('id');
          else if (f === 'sqlite') q = q.orderByRaw('rowid');
          const batch = await q.limit(READ_BATCH).offset(offset);
          for (const row of batch) {
            for (const [k, v] of Object.entries(row)) {
              const s = stats[k];
              if (!s) continue;
              if (v === null || v === undefined) s.nulls++;
              else if (isEmptyText(v)) s.empties++;
              else if (typeof v === 'number' || (typeof v === 'string' && /^[-+]?\d+$/.test(v))) {
                const n = Math.abs(Number(v));
                if (Number.isFinite(n) && n > s.extreme) s.extreme = n;
              }
            }
            await write(`${JSON.stringify(encode(row))}\n`);
          }
          rows += batch.length;
          if (batch.length < READ_BATCH) break;
        }
      } finally {
        await new Promise((resolve) => out.end(resolve));
      }
      schema.tables.push({ name: table, file, rows, columns, stats });
      total += rows;
    }
  });

  await fs.promises.writeFile(path.join(dir, 'schema.json'), JSON.stringify(schema, null, 2));
  return { tables: schema.tables.length, rows: total };
}

/** Reads the schema of an exported database (throws when `dir` isn't one). */
export function readExport(dir) {
  const file = path.join(dir, 'schema.json');
  if (!fs.existsSync(file)) throw new Error('The backup has no Loopar database export (schema.json).');
  const schema = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (schema.format !== PORTABLE_FORMAT) throw new Error('The backup\'s database export is not in Loopar\'s format.');
  if (Number(schema.version) > PORTABLE_VERSION) throw new Error(`The backup's database export is version ${schema.version}; this server reads up to ${PORTABLE_VERSION}. Update Loopar first.`);
  for (const t of schema.tables) {
    // Only the files of this export: a name is never a path.
    if (!/^t\d+\.ndjson$/.test(String(t.file))) throw new Error('The backup\'s database export is not valid (table file).');
  }
  return schema;
}

/* ----------------------------------------------------------------- sources */

/**
 * What a copy reads from a source:
 *   dialect, tables(), describe(table), count(table),
 *   countEmpty(table, column, isText), extreme(table, column),
 *   batches(table, size) → async iterator of row arrays.
 */

/** A live database (KnexORM). */
export function liveSource(orm) {
  const order = async (table, q) => {
    const cols = await orm.getTableDescription(table);
    if (cols.some((c) => String(c.name).toLowerCase() === 'id')) return q.orderBy('id');
    return family(orm.dialect) === 'sqlite' ? q.orderByRaw('rowid') : q;
  };
  return {
    kind: 'database',
    dialect: family(orm.dialect),
    tables: () => tablesOf(orm.knex, orm.dialect),
    describe: (table) => orm.getTableDescription(table),
    count: async (table) => Number((await orm.knex(table).count({ n: '*' }))[0]?.n ?? 0),
    countEmpty: async (table, column, isText) => {
      const q = orm.knex(table).whereNull(column);
      if (!isText) q.orWhere(column, '');
      return Number((await q.count({ n: '*' }))[0]?.n ?? 0);
    },
    extreme: async (table, column) => {
      const [r] = await orm.knex(table).max({ hi: column }).min({ lo: column });
      return Math.max(Math.abs(Number(r?.hi) || 0), Math.abs(Number(r?.lo) || 0));
    },
    async *batches(table, size = READ_BATCH) {
      const total = await this.count(table);
      for (let offset = 0; offset < total; offset += size) {
        yield await (await order(table, orm.knex(table).select('*'))).limit(size).offset(offset);
      }
    },
  };
}

/** A database exported with exportDatabase (a folder). */
export function fileSource(dir) {
  const schema = readExport(dir);
  const byName = new Map(schema.tables.map((t) => [t.name, t]));
  const table = (name) => {
    const t = byName.get(name);
    if (!t) throw new Error(`The export has no table "${name}".`);
    return t;
  };
  return {
    kind: 'file',
    dialect: schema.dialect,
    exportedAt: schema.exportedAt,
    tables: async () => schema.tables.map((t) => t.name),
    describe: async (name) => table(name).columns,
    count: async (name) => table(name).rows,
    countEmpty: async (name, column, isText) => {
      const s = table(name).stats?.[column];
      return s ? s.nulls + (isText ? 0 : s.empties) : 0;
    },
    extreme: async (name, column) => table(name).stats?.[column]?.extreme ?? 0,
    async *batches(name, size = READ_BATCH) {
      const lines = readline.createInterface({ input: fs.createReadStream(path.join(dir, table(name).file)), crlfDelay: Infinity });
      let batch = [];
      for await (const line of lines) {
        if (!line.trim()) continue;
        batch.push(decode(JSON.parse(line)));
        if (batch.length >= size) { yield batch; batch = []; }
      }
      if (batch.length) yield batch;
    },
  };
}
