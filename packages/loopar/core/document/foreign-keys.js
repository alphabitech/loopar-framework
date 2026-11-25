'use strict';

/**
 * Database foreign keys for Loopar's links (PostgreSQL and MySQL/MariaDB;
 * SQLite has none — the ORM checks still apply there). Always RESTRICT:
 * the database never deletes in cascade, the framework does that through
 * each record's model (core/document/referential-integrity.js → deleteRecords).
 *
 * They are reconciled, not migrated: `syncForeignKeys` reads the links the
 * refs declare and the framework's constraints the database has (named
 * `fk_…`), drops what no longer matches and creates what is missing. It runs
 * at the end of every loopar.build() (boot, entity saves, installs), after a
 * tenant migration, and from `yarn integrity <tenant> --sync`.
 *
 *   - link:  <entity>.<connection field> → <target>.name, for simple (not
 *            multiple) connections between tables. Links to structure records
 *            (Entity, builders, Module, App) get none: the installer owns those
 *            and removes them in its own order.
 *   - child: <child>.parent_id → <parent>.id, for child entities used by a
 *            single parent entity (parent_document is then always that one).
 *
 * Before creating one, the column is prepared: '' becomes NULL, a TEXT column
 * becomes VARCHAR, and the target gets UNIQUE(name). A key whose data still
 * has orphans (or whose target has duplicate names) is not created: it is
 * reported, and `yarn integrity <tenant>` lists the rows to fix.
 *
 * In "warn" integrity mode the framework's keys are removed instead.
 */

import crypto from 'node:crypto';
import { loopar } from '../loopar.js';
import { linkIndex, setEnforcedForeignKeys } from './referential-integrity.js';
import { isStrict } from '../global/integrity-mode.js';

export const FK_PREFIX = 'fk_';
const STRUCTURE_TARGETS = new Set(['entity', 'module', 'module group', 'app', 'builder']);

export const supportsForeignKeys = (db) => !!(db?.isPostgresLike || db?.isMySQLLike);

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

/** Deterministic constraint name, ≤ 60 chars (PG 63, MySQL 64). */
export function fkName(table, column) {
  const base = `${FK_PREFIX}${slug(table)}__${slug(column)}`;
  if (base.length <= 60) return base;
  const hash = crypto.createHash('sha1').update(`${table}\u0000${column}`).digest('hex').slice(0, 8);
  return `${base.slice(0, 51)}_${hash}`;
}

const q = (db, id) => (db.isPostgresLike ? `"${String(id).replace(/"/g, '""')}"` : `\`${String(id).replace(/`/g, '``')}\``);
const rows = (db, result) => db.unwrapRawRows ? db.unwrapRawRows(result) : (result?.rows ?? result?.[0] ?? result);

function isStructureTarget(target) {
  if (STRUCTURE_TARGETS.has(String(target).toLowerCase())) return true;
  const ref = loopar.getRef(target, false);
  return !!ref?.is_builder;
}

/** The keys the refs declare: [{ name, table, column, refTable, refColumn, kind }]. */
export function desiredForeignKeys() {
  const { outgoing, childParents } = linkIndex();
  const out = [];
  for (const ref of Object.values(loopar.getRefs())) {
    if (ref.is_virtual || ref.is_single) continue;
    for (const link of outgoing.get(loopar.utils.toEntityKey(ref.__NAME__)) || []) {
      if (link.multiple || isStructureTarget(link.target)) continue;
      const target = loopar.getRef(link.target, false);
      if (!target || target.is_virtual || target.is_single) continue;
      out.push({ name: fkName(ref.__NAME__, link.field), table: ref.__NAME__, column: link.field, refTable: target.__NAME__, refColumn: 'name', kind: 'link', required: link.required });
    }
  }
  for (const [childKey, parents] of childParents) {
    const child = loopar.getRef(childKey, false);
    if (!child || parents.length !== 1) continue;
    const parent = loopar.getRef(parents[0], false);
    if (!parent || parent.is_virtual || parent.is_single) continue;
    out.push({ name: fkName(child.__NAME__, 'parent_id'), table: child.__NAME__, column: 'parent_id', refTable: parent.__NAME__, refColumn: 'id', kind: 'child' });
  }
  return out;
}

/** The framework's keys in the database: [{ name, table, column, refTable, refColumn }]. */
export async function existingForeignKeys(db) {
  if (db.isPostgresLike) {
    return rows(db, await db.qx().raw(`
      SELECT con.conname AS name, rel.relname AS "table", att.attname AS "column",
             frel.relname AS "refTable", fatt.attname AS "refColumn"
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
        JOIN pg_namespace ns ON ns.oid = rel.relnamespace
        JOIN pg_class frel ON frel.oid = con.confrelid
        JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = con.conkey[1]
        JOIN pg_attribute fatt ON fatt.attrelid = con.confrelid AND fatt.attnum = con.confkey[1]
       WHERE con.contype = 'f' AND ns.nspname = current_schema() AND con.conname LIKE ?`, [`${FK_PREFIX}%`]));
  }
  if (db.isMySQLLike) {
    return rows(db, await db.qx().raw(`
      SELECT CONSTRAINT_NAME AS name, TABLE_NAME AS \`table\`, COLUMN_NAME AS \`column\`,
             REFERENCED_TABLE_NAME AS refTable, REFERENCED_COLUMN_NAME AS refColumn
        FROM information_schema.KEY_COLUMN_USAGE
       WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL AND CONSTRAINT_NAME LIKE ?`, [db.database, `${FK_PREFIX}%`]));
  }
  return [];
}

export async function dropForeignKey(db, fk) {
  const sql = db.isPostgresLike
    ? `ALTER TABLE ${q(db, fk.table)} DROP CONSTRAINT IF EXISTS ${q(db, fk.name)}`
    : `ALTER TABLE ${q(db, fk.table)} DROP FOREIGN KEY ${q(db, fk.name)}`;
  await db.qx().raw(sql);
}

/** Removes every framework key (all tables, or only `table`). */
export async function dropForeignKeys(db = loopar.db, { table = null } = {}) {
  if (!supportsForeignKeys(db)) return 0;
  const list = (await existingForeignKeys(db)).filter((fk) => !table || fk.table.toLowerCase() === String(table).toLowerCase());
  for (const fk of list) await dropForeignKey(db, fk);
  if (db === loopar.db) setEnforcedForeignKeys([]);
  return list.length;
}

const same = (a, b) => ['table', 'column', 'refTable', 'refColumn']
  .every((k) => String(a[k]).toLowerCase() === String(b[k]).toLowerCase());

async function columnType(db, table, column) {
  const col = (await db.getTableDescription(table)).find((c) => c.name.toLowerCase() === column.toLowerCase());
  return col ? String(col.type || '').toLowerCase() : null;
}

async function hasUniqueName(db, table) {
  if (db.isPostgresLike) {
    const r = rows(db, await db.qx().raw(`
      SELECT 1 FROM pg_index i
        JOIN pg_class c ON c.oid = i.indrelid
        JOIN pg_namespace ns ON ns.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = i.indkey[0]
       WHERE ns.nspname = current_schema() AND c.relname = ? AND i.indisunique AND i.indnatts = 1 AND a.attname = 'name'
       LIMIT 1`, [table]));
    return r.length > 0;
  }
  const r = rows(db, await db.qx().raw(`
    SELECT INDEX_NAME FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND NON_UNIQUE = 0
     GROUP BY INDEX_NAME HAVING COUNT(*) = 1 AND MAX(COLUMN_NAME) = 'name'`, [db.database, table]));
  return r.length > 0;
}

/** Makes the column and its target fit a key. Returns a problem (string) or null. */
async function prepare(db, fk) {
  if (!(await db.hasTable(fk.table)) || !(await db.hasTable(fk.refTable))) return 'table missing';
  const type = await columnType(db, fk.table, fk.column);
  if (!type) return `column ${fk.column} missing`;

  if (fk.kind === 'link') {
    // No value is NULL, not '' (a required column keeps '': it is reported below).
    if (!fk.required) await db.qx()(fk.table).where(fk.column, '').update({ [fk.column]: null });

    if (/text/.test(type)) {
      const longest = (await db.qx()(fk.table).select(db.qx().raw('MAX(LENGTH(??)) AS n', [fk.column])).first())?.n;
      if (Number(longest) > 255) return `values longer than 255 characters in ${fk.column}`;
      await db.qx().raw(db.isPostgresLike
        ? `ALTER TABLE ${q(db, fk.table)} ALTER COLUMN ${q(db, fk.column)} TYPE VARCHAR(255)`
        : `ALTER TABLE ${q(db, fk.table)} MODIFY ${q(db, fk.column)} VARCHAR(255) NULL`);
      db.invalidateColumnsCache?.(fk.table);
    }

    if (!(await hasUniqueName(db, fk.refTable))) {
      const dup = await db.qx()(fk.refTable).select('name').groupBy('name').havingRaw('COUNT(*) > 1').first();
      if (dup) return `${fk.refTable} has duplicate names (e.g. "${dup.name}")`;
      await db.qx().schema.alterTable(fk.refTable, (t) => t.unique(['name']));
    }
  } else if (db.isMySQLLike) {
    // parent_id was created signed; MySQL keys need the same type as the id.
    const idType = await columnType(db, fk.refTable, 'id');
    if (/unsigned/.test(idType || '') && !/unsigned/.test(type)) {
      await db.qx().raw(`ALTER TABLE ${q(db, fk.table)} MODIFY ${q(db, fk.column)} INT UNSIGNED NULL`);
      db.invalidateColumnsCache?.(fk.table);
    }
  }

  const orphan = await db.qx()({ s: fk.table })
    .leftJoin({ t: fk.refTable }, `s.${fk.column}`, `t.${fk.refColumn}`)
    .whereNotNull(`s.${fk.column}`).whereNull(`t.${fk.refColumn}`)
    .count({ n: '*' }).first();
  // '' left in a required column counts as an orphan: no record is named ''.
  if (Number(orphan?.n) > 0) return `${orphan.n} row(s) of ${fk.table}.${fk.column} point to missing ${fk.refTable} records`;
  return null;
}

async function createForeignKey(db, fk) {
  await db.qx().schema.alterTable(fk.table, (t) => {
    t.foreign(fk.column, fk.name).references(fk.refColumn).inTable(fk.refTable).onDelete('RESTRICT').onUpdate('RESTRICT');
  });
}

const enforcedKey = (fk) => `${loopar.utils.toEntityKey(fk.table)}\u0000${fk.column.toLowerCase()}`;

/**
 * Reconciles the framework's keys with the refs. Never throws: what can't be
 * created is returned in `issues`.
 * → { skipped?, created: [], dropped: [], kept: [], issues: [{ name, table, column, problem }] }
 */
export async function syncForeignKeys(db = loopar.db, { strict = isStrict() } = {}) {
  const result = { created: [], dropped: [], kept: [], issues: [] };
  if (!supportsForeignKeys(db)) {
    if (db === loopar.db) setEnforcedForeignKeys([]);
    return { ...result, skipped: true };
  }

  try {
    const existing = await existingForeignKeys(db);
    if (!strict) {
      for (const fk of existing) { await dropForeignKey(db, fk); result.dropped.push(fk.name); }
      if (db === loopar.db) setEnforcedForeignKeys([]);
      return result;
    }

    const desired = new Map(desiredForeignKeys().map((fk) => [fk.name, fk]));
    const enforced = [];

    for (const fk of existing) {
      const want = desired.get(fk.name);
      if (want && same(want, fk)) { result.kept.push(fk.name); if (want.kind === 'link') enforced.push(enforcedKey(want)); continue; }
      await dropForeignKey(db, fk);
      result.dropped.push(fk.name);
    }

    for (const fk of desired.values()) {
      if (result.kept.includes(fk.name)) continue;
      try {
        const problem = await prepare(db, fk);
        if (problem) { result.issues.push({ name: fk.name, table: fk.table, column: fk.column, problem }); continue; }
        await createForeignKey(db, fk);
        result.created.push(fk.name);
        if (fk.kind === 'link') enforced.push(enforcedKey(fk));
      } catch (e) {
        result.issues.push({ name: fk.name, table: fk.table, column: fk.column, problem: e.message });
      }
    }

    if (db === loopar.db) setEnforcedForeignKeys(enforced);
  } catch (e) {
    result.issues.push({ name: '*', problem: e.message });
  }

  if (result.created.length || result.dropped.length) {
    console.log(`[foreign-keys] ${loopar.tenantId || ''}: ${result.created.length} created, ${result.dropped.length} dropped, ${result.kept.length} kept`);
  }
  if (result.issues.length) {
    console.warn(`[foreign-keys] ${loopar.tenantId || ''}: ${result.issues.length} key(s) not created — run \`yarn integrity ${loopar.tenantId || '<tenant>'}\``);
  }
  return result;
}
