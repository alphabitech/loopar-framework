'use strict';

/**
 * Data migrations of an app: what a declarative entity change can't say.
 *
 * The tables follow the entities by themselves (Entity.save → makeTable:
 * new columns, type changes; removed fields stay as orphan columns). What
 * that can't know is the intent behind a change: a renamed field reads as
 * "one column gone, another one new", and its values would stay behind in
 * the old column. A migration says what to do with the data.
 *
 *   apps/<app>/migrations/NNNN-<slug>.js
 *
 *     export const description = 'Customer: phone → phone_number';
 *     export async function up({ loopar, db, knex, migrate, log }) {
 *       await migrate.renameColumn('Customer', 'phone', 'phone_number');
 *     }
 *
 * Only `up`: the way back of a data change is the snapshot taken before the
 * update. A migration, once shipped, is never edited: a correction is a new
 * migration.
 *
 * When they run (Installer):
 *   - update of an app: after its entities (and so its tables) are written,
 *     the migrations this tenant hasn't applied yet, in order, each in its
 *     own transaction together with the record that it ran;
 *   - fresh install: none run (there is no old data); they are recorded as
 *     applied, so a later update only runs the ones that come after.
 * The designer writes one when an entity change needs it (a renamed field)
 * and applies it right away on the developer's tenant.
 *
 * Applied migrations are recorded per tenant in the table below (not an
 * entity: it exists before any app and outlives their uninstalls).
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loopar } from '../loopar.js';
import { renameFieldReferencesInDatabase } from './field-rename.js';

export const MIGRATIONS_TABLE = 'loopar_app_migrations';
const FILE_RE = /^(\d{4})-[a-z0-9][a-z0-9-]*\.js$/;

/* ------------------------------------------------------------------ files */

/** The app's folder (apps/<app>, or the framework's own core app). */
function appRoot(app) {
  const found = (loopar.getApps?.() || []).find((a) => a.name === app);
  return loopar.makePath(loopar.pathRoot, found?.appRoot || path.join('apps', app));
}

export const migrationsDir = (app) => path.join(appRoot(app), 'migrations');

/** The app's migration files, in order. */
export function migrationFiles(app) {
  const dir = migrationsDir(app);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => FILE_RE.test(f)).sort();
}

const slugify = (text) => String(text || '').toLowerCase()
  .normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'migration';

const jsString = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, ' ')}'`;

/**
 * Write a new migration file for `app` (the next number). `body`: the lines
 * inside `up` (indented by the caller or not); empty, a template to fill.
 * @returns {{ app, name, file }}
 */
export function createMigration(app, { description, body = '' } = {}) {
  if (!app) throw new Error('A migration belongs to an app.');
  const dir = migrationsDir(app);
  fs.mkdirSync(dir, { recursive: true });
  const last = migrationFiles(app).map((f) => Number(f.slice(0, 4))).reduce((a, b) => Math.max(a, b), 0);
  const name = `${String(last + 1).padStart(4, '0')}-${slugify(description)}.js`;
  const lines = String(body || '').trim()
    ? String(body).trim().split('\n').map((l) => `  ${l.trim()}`).join('\n')
    : [
      "  // What to do with the existing data, e.g.:",
      "  // await migrate.renameColumn('Entity', 'old_field', 'new_field');",
      "  // await knex('Entity').where('status', 'Old').update({ status: 'New' });",
    ].join('\n');
  const content = [
    "'use strict';",
    '',
    '/**',
    ` * ${String(description || name).replace(/\*\//g, '* /')}`,
    ' * Data migration (core/document/app-migrations.js): runs once per tenant,',
    ' * on the update that ships it. Never edit it once shipped: add a new one.',
    ' */',
    `export const description = ${jsString(description || name)};`,
    '',
    'export async function up({ loopar, db, knex, migrate, log }) {',
    lines,
    '}',
    '',
  ].join('\n');
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return { app, name, file };
}

/* ------------------------------------------------------------------ record */

// Through qx(): inside an open transaction (an entity save) a second
// connection would wait for it forever on SQLite (one writer).
async function ensureTable(db = loopar.db) {
  if (await db.qx().schema.hasTable(MIGRATIONS_TABLE)) return;
  await db.qx().schema.createTable(MIGRATIONS_TABLE, (t) => {
    t.increments('id');
    t.string('app', 140).notNullable();
    t.string('name', 200).notNullable();
    t.string('description', 500).nullable();
    t.datetime('applied_at').notNullable();
    t.integer('duration_ms').nullable();
    t.boolean('baseline').notNullable().defaultTo(false);
    t.unique(['app', 'name']);
  });
}

/** Names of the app's migrations this tenant already has (ran or baselined). */
export async function appliedMigrations(app) {
  await ensureTable();
  const rows = await loopar.db.qx()(MIGRATIONS_TABLE).where({ app }).select('name');
  return new Set(rows.map((r) => r.name));
}

export async function pendingMigrations(app) {
  const applied = await appliedMigrations(app);
  return migrationFiles(app).filter((f) => !applied.has(f));
}

const record = (q, app, name, { description = null, duration = null, baseline = false } = {}) =>
  q(MIGRATIONS_TABLE).insert({ app, name, description, applied_at: new Date(), duration_ms: duration, baseline });

/** Fresh install: the app's migrations count as applied (there was no old data to move). */
export async function baselineMigrations(app) {
  const pending = await pendingMigrations(app);
  for (const name of pending) await record(loopar.db.qx(), app, name, { baseline: true });
  return pending;
}

/* ----------------------------------------------------------------- helpers */

/**
 * What a migration gets as `migrate`. `aliases`: a copy whose target column
 * doesn't exist on this tenant (a field renamed twice between two updates:
 * a → b → c, and the tables only ever had a and c) is remembered, so the
 * next copy from that column reads from the real one.
 */
function helpers(db, aliases) {
  const columns = async (entity) => new Set((await db.getTableDescription(entity)).map((c) => String(c.name)));

  const api = {
    /**
     * Values of `from` into `to` where `to` is still empty (a renamed field:
     * the old column stays, as an orphan, until it is released). Returns how
     * many records were filled. Missing columns are not an error: a tenant
     * that never had the old one has nothing to move.
     */
    async copyColumn(entity, from, to) {
      const have = await columns(entity);
      const source = have.has(from) ? from : aliases.get(`${entity}.${from}`);
      if (!source || !have.has(source)) return 0;
      if (!have.has(to)) {
        aliases.set(`${entity}.${to}`, source);
        return 0;
      }
      return await db.qx()(entity).whereNull(to).whereNotNull(source).update({ [to]: db.knex.ref(source) });
    },

    /**
     * A renamed field: its values into the new column (copyColumn), then the
     * old column goes — only when no field of the entity declares it any
     * more (the refs say what the entity has now). Its foreign keys go with
     * it and come back from the refs at the next build. Returns how many
     * records were filled.
     */
    async renameColumn(entity, from, to) {
      const copied = await api.copyColumn(entity, from, to);
      const have = await columns(entity);
      const source = have.has(from) ? from : aliases.get(`${entity}.${from}`);
      if (!source || !have.has(source) || !have.has(to)) return copied;
      const declared = new Set((loopar.getRef(entity, false)?.__FIELDS__ || []).map(String));
      if (declared.has(source)) return copied;
      await db.dropFrameworkForeignKeys?.(entity);
      await db.dropOrphanColumn(entity, source);
      return copied;
    },

    /**
     * The places in this tenant's database that name a renamed field: other
     * entities' structures (formulas through a connection, connection
     * filters), the entity's title/search fields, list settings, saved views
     * and workflows (core/document/field-rename.js). Returns what changed.
     */
    async renameFieldReferences(entity, from, to) {
      return await renameFieldReferencesInDatabase({ entity, from, to }, db);
    },

    /** Replace a stored value of a field (a renamed select option, a status…). */
    async renameValue(entity, field, from, to) {
      if (!(await columns(entity)).has(field)) return 0;
      return await db.qx()(entity).where(field, from).update({ [field]: to });
    },

    /** Does the table of `entity` have this column on this tenant? */
    async hasColumn(entity, column) {
      return (await columns(entity)).has(column);
    },
  };
  return api;
}

/* --------------------------------------------------------------------- run */

async function load(app, name) {
  const file = path.join(migrationsDir(app), name);
  const mod = await import(`${pathToFileURL(file).href}?v=${fs.statSync(file).mtimeMs}`);
  if (typeof mod.up !== 'function') throw new Error(`Migration ${app}/${name} has no up() function.`);
  return mod;
}

/**
 * Run `app`'s pending migrations (or just `only`), in order. Each one and
 * the record that it ran share a transaction: a failure leaves that
 * migration pending (and stops there).
 * @returns {Promise<Array<{ name, description, ms }>>}
 */
export async function runMigrations(app, { only = null, log = () => {}, onEach = () => {} } = {}) {
  const pending = (await pendingMigrations(app)).filter((n) => !only || only.includes(n));
  const db = loopar.db;
  const aliases = new Map();
  const done = [];
  for (const [i, name] of pending.entries()) {
    const mod = await load(app, name);
    const description = mod.description || name;
    onEach({ name, description, index: i, total: pending.length });
    const started = Date.now();
    try {
      await db.withTransaction(async () => {
        await mod.up({ loopar, db, knex: db.qx(), migrate: helpers(db, aliases), log });
        await record(db.qx(), app, name, { description: String(description).slice(0, 500), duration: Date.now() - started });
      });
    } catch (e) {
      e.message = `Data migration ${app}/${name} failed: ${e.message}`;
      throw e;
    }
    const ms = Date.now() - started;
    log(`Migrated: ${description} (${ms} ms)`);
    done.push({ name, description, ms });
  }
  return done;
}

/* --------------------------------------------------------------- designer */

/**
 * Fields of a doc_structure by their designer node (stable across renames):
 * node → { name, element }, for fields with a column.
 */
export function fieldsByNode(structure, hasColumn) {
  const out = new Map();
  const walk = (els = []) => {
    for (const el of els) {
      if (el?.node && el.data?.name && hasColumn(el)) out.set(el.node, { name: el.data.name, element: el.element });
      walk(el?.elements);
    }
  };
  walk(Array.isArray(structure) ? structure : []);
  return out;
}

/**
 * Fields renamed between two versions of an entity's structure: same node,
 * another name — and the old name is not reused by another field.
 * @returns {Array<{ from, to }>}
 */
export function renamedFields(before, after, hasColumn) {
  const prev = fieldsByNode(before, hasColumn);
  const next = fieldsByNode(after, hasColumn);
  const nextNames = new Set([...next.values()].map((f) => f.name));
  const renames = [];
  for (const [node, field] of next) {
    const old = prev.get(node);
    if (!old || old.name === field.name || nextNames.has(old.name)) continue;
    renames.push({ from: old.name, to: field.name });
  }
  return renames;
}
