'use strict';

/**
 * Tenant database dump/restore, without the framework (works from the CLI
 * and the TUI too): the connection comes from sites/<tenant>/config/db.config.json.
 *
 *   sqlite         → online copy with better-sqlite3's backup API (consistent
 *                    while the tenant keeps serving).
 *   mysql/mariadb  → logical NDJSON dump through Knex: per table its
 *                    `SHOW CREATE TABLE` and its rows in batches. Restored the
 *                    same way, so no mysql client binaries are needed.
 *   postgres       → pg_dump / pg_restore (custom format); both must be on PATH.
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import knexFactory from 'knex';

const BATCH = 500;

export function siteDir(root, tenant) {
  return path.join(root, 'sites', tenant);
}

export function readDbConfig(root, tenant) {
  const file = path.join(siteDir(root, tenant), 'config', 'db.config.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { cfg = {}; }
  return { dialect: 'sqlite', ...cfg };
}

export const dialectOf = (cfg) => {
  const d = String(cfg?.dialect || 'sqlite').toLowerCase();
  if (/sqlite/.test(d)) return 'sqlite';
  if (/mysql|mariadb/.test(d)) return 'mysql';
  if (/postgres|pg/.test(d)) return 'postgres';
  return d;
};

export function sqlitePath(root, tenant) {
  return path.join(siteDir(root, tenant), 'database', `${tenant}.sqlite`);
}

const conn = (cfg) => ({ ...(cfg.connection || {}), host: cfg.connection?.host || cfg.host || 'localhost' });

/** A short-lived Knex connection to a tenant's database. */
export function openKnex(root, tenant, { readonly = false } = {}) {
  const cfg = readDbConfig(root, tenant);
  const dialect = dialectOf(cfg);
  if (dialect === 'sqlite') {
    return knexFactory({
      client: 'better-sqlite3',
      connection: { filename: sqlitePath(root, tenant), options: { readonly } },
      useNullAsDefault: true,
      pool: { min: 1, max: 1 },
    });
  }
  if (dialect === 'mysql') {
    const c = conn(cfg);
    return knexFactory({
      client: 'mysql2',
      connection: {
        host: c.host, port: c.port || 3306, user: c.user || cfg.user, password: c.password ?? cfg.password,
        database: cfg.database, dateStrings: true, supportBigNumbers: true, bigNumberStrings: true, multipleStatements: false,
      },
      pool: { min: 0, max: 2 },
    });
  }
  if (dialect === 'postgres') {
    const c = conn(cfg);
    return knexFactory({
      client: 'pg',
      connection: { host: c.host, port: c.port || 5432, user: c.user || cfg.user, password: c.password ?? cfg.password, database: cfg.database },
      pool: { min: 0, max: 2 },
    });
  }
  throw new Error(`Backups don't support the "${cfg.dialect}" database yet (SQLite, MySQL/MariaDB and PostgreSQL do).`);
}

function run(cmd, args, { env = {}, stdoutFile = null, stdinFile = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    if (stdoutFile) child.stdout.pipe(fs.createWriteStream(stdoutFile));
    if (stdinFile) fs.createReadStream(stdinFile).pipe(child.stdin); else child.stdin.end();
    child.on('error', (e) => reject(e.code === 'ENOENT' ? new Error(`"${cmd}" is not installed on this server (needed for PostgreSQL backups).`) : e));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} failed (${code}): ${err.slice(-500)}`))));
  });
}

const encodeRow = (row) => {
  const out = {};
  for (const [k, v] of Object.entries(row)) out[k] = Buffer.isBuffer(v) ? { $b64: v.toString('base64') } : v;
  return out;
};
const decodeRow = (row) => {
  const out = {};
  for (const [k, v] of Object.entries(row)) out[k] = v && typeof v === 'object' && '$b64' in v ? Buffer.from(v.$b64, 'base64') : v;
  return out;
};

/**
 * Dump the tenant database into `outDir`.
 * @returns {Promise<{ dialect, file }>}  file name relative to outDir
 */
export async function dumpDatabase(root, tenant, outDir) {
  const cfg = readDbConfig(root, tenant);
  const dialect = dialectOf(cfg);

  if (dialect === 'sqlite') {
    const src = sqlitePath(root, tenant);
    if (!fs.existsSync(src)) throw new Error(`Database file not found: ${src}`);
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(src, { readonly: true, fileMustExist: true });
    try {
      await db.backup(path.join(outDir, 'database.sqlite'));
    } finally {
      db.close();
    }
    return { dialect, file: 'database.sqlite' };
  }

  if (dialect === 'mysql') {
    const knex = openKnex(root, tenant);
    const file = path.join(outDir, 'database.mysql.ndjson');
    const out = fs.createWriteStream(file);
    const write = (obj) => new Promise((resolve) => { if (out.write(`${JSON.stringify(obj)}\n`)) resolve(); else out.once('drain', resolve); });
    try {
      const [tables] = await knex.raw("SHOW FULL TABLES WHERE Table_type = 'BASE TABLE'");
      for (const t of tables) {
        const table = Object.values(t)[0];
        const [[create]] = await knex.raw('SHOW CREATE TABLE ??', [table]);
        await write({ t: 'table', table, ddl: create['Create Table'] });
        for (let offset = 0; ; offset += BATCH) {
          const rows = await knex.select('*').from(table).limit(BATCH).offset(offset);
          if (!rows.length) break;
          await write({ t: 'rows', table, rows: rows.map(encodeRow) });
          if (rows.length < BATCH) break;
        }
      }
    } finally {
      await new Promise((resolve) => out.end(resolve));
      await knex.destroy();
    }
    return { dialect, file: 'database.mysql.ndjson' };
  }

  if (dialect === 'postgres') {
    const c = conn(cfg);
    const file = 'database.pgdump';
    await run('pg_dump', ['--format=custom', '--no-owner', '--host', c.host, '--port', String(c.port || 5432), '--username', String(c.user || cfg.user), '--dbname', cfg.database, '--file', path.join(outDir, file)],
      { env: { PGPASSWORD: c.password ?? cfg.password ?? '' } });
    return { dialect, file };
  }

  throw new Error(`Backups don't support the "${cfg.dialect}" database yet.`);
}

// A dump replays statements: only a plain CREATE TABLE of a table of this database.
function checkedTable(name) {
  if (typeof name !== 'string' || !name || /[.`\\]/.test(name)) throw new Error('The database dump is not valid (table name).');
  return name;
}
export function checkedDdl(rec) {
  const table = checkedTable(rec.table ?? String(rec.ddl).match(/^CREATE TABLE `([^`]+)`/)?.[1]);
  const ddl = String(rec.ddl);
  // Quoted literals (defaults, comments) and identifiers can say anything; the statement itself can't.
  const bare = ddl.replace(/'(?:[^'\\]|\\.|'')*'/g, "''").replace(/`[^`]*`/g, '``');
  if (!ddl.startsWith(`CREATE TABLE \`${table}\` (`) || /\bSELECT\b|\bREFERENCES\s+``\s*\.|\bDATA\s+DIRECTORY\b|\bINDEX\s+DIRECTORY\b/i.test(bare)) {
    throw new Error(`The database dump is not valid (definition of ${table}).`);
  }
  return ddl;
}

/**
 * Replace the tenant database with a dump. For SQLite the dump file is
 * placed by the caller (it is just the database file); this handles servers.
 */
export async function restoreDatabase(root, tenant, dialect, dumpFile) {
  if (dialect === 'mysql') {
    const knex = openKnex(root, tenant);
    try {
      await knex.raw('SET FOREIGN_KEY_CHECKS = 0');
      const [existing] = await knex.raw("SHOW FULL TABLES WHERE Table_type = 'BASE TABLE'");
      for (const t of existing) await knex.raw('DROP TABLE IF EXISTS ??', [Object.values(t)[0]]);
      const lines = readline.createInterface({ input: fs.createReadStream(dumpFile), crlfDelay: Infinity });
      for await (const line of lines) {
        if (!line.trim()) continue;
        const rec = JSON.parse(line);
        if (rec.t === 'table') await knex.raw(checkedDdl(rec));
        else if (rec.t === 'rows' && rec.rows?.length) await knex(checkedTable(rec.table)).insert(rec.rows.map(decodeRow));
      }
      await knex.raw('SET FOREIGN_KEY_CHECKS = 1');
    } finally {
      await knex.destroy();
    }
    return;
  }
  if (dialect === 'postgres') {
    const cfg = readDbConfig(root, tenant);
    const c = conn(cfg);
    await run('pg_restore', ['--clean', '--if-exists', '--no-owner', '--host', c.host, '--port', String(c.port || 5432), '--username', String(c.user || cfg.user), '--dbname', cfg.database, dumpFile],
      { env: { PGPASSWORD: c.password ?? cfg.password ?? '' } });
    return;
  }
  throw new Error(`Restoring a "${dialect}" database is not supported.`);
}

/** Installed app versions as recorded in the tenant database ({} when unreadable). */
export async function appVersions(root, tenant) {
  let knex;
  try {
    knex = openKnex(root, tenant, { readonly: true });
    const rows = await knex('App').select('name', 'version');
    return Object.fromEntries(rows.map((r) => [r.name, r.version ?? null]));
  } catch {
    return {};
  } finally {
    await knex?.destroy().catch(() => {});
  }
}
