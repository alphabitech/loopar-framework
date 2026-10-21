'use strict';

/**
 * Physical rename of an entity (Entity, Page, Form, View, Report, Print
 * Format, Contact Form…). Entity names are unique per tenant and are the
 * identity everywhere — folder, files, table, and every reference stored by
 * name — so a rename has to move all of them together:
 *
 *   files      apps/<app>/modules/<module>/<type>/<old-slug>/ → <new-slug>/,
 *              <slug>.json / .js / -controller.js / client/<slug>-*.jsx,
 *              class names, the `name` inside the JSON, and references in
 *              every app's JSON (doc_structure options, menu pages…)
 *   database   the meta row, the table (or single values), and every column
 *              that stores an entity name (history, comments, page views,
 *              permissions, menus, child rows' parent_document…)
 *
 * Files are shared by every tenant but each tenant has its own database, so
 * the database part is also recorded in `apps/<app>/renames.json` and the
 * installer replays it on every tenant when the app is updated
 * (applyRenameToDatabase is idempotent).
 *
 * Names written in source code (getDocument("Old")…) are never rewritten:
 * they are reported as `codeUsages` for the developer to review.
 */
import fs from "fs";
import path from "pathe";
import { loopar } from "../loopar.js";
import { fileManage } from "../file-manage.js";

/** Keys whose string value may be an entity name, in JSON (doc_structure, installer data). */
const JSON_NAME_KEYS = new Set(["options", "entity", "for_entity", "page", "document", "parent_document"]);
/** Keys whose value may be a desk link (`/desk/<Entity>/…`). */
const JSON_LINK_KEYS = new Set(["to", "href", "link"]);
/** Database columns that store an entity name. */
const DB_NAME_COLUMNS = ["document", "page", "parent_document", "for_entity", "entity", "options"];
/** Types whose files cannot be renamed here (framework-defining). */
const NOT_RENAMABLE_TYPES = new Set(["Builder"]);

const slugOf = (name) => fileManage.folderName(name);
const classOf = (name) => fileManage.className(name);
const abs = (p) => path.join(loopar.pathRoot, p);
const metaTables = () => [...new Set(["Entity", ...Object.keys(loopar.getTypes() || {})])];

/* ------------------------------------------------------------------ JSON */

/** Rewrite references to `from` inside any JSON value (deep). Returns [value, changed]. */
export function rewriteRefs(value, from, to) {
  let changed = false;

  const linkRe = new RegExp(`^(/desk/)${from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=/|$|\\?)`);

  const walk = (node, key = null) => {
    if (typeof node === "string") {
      if (key === "doc_structure") {
        const parsed = loopar.utils.isJSON(node) ? JSON.parse(node) : null;
        if (!parsed) return node;
        const out = walk(parsed);
        return out === parsed ? node : JSON.stringify(out);
      }
      if (key && JSON_NAME_KEYS.has(key) && node === from) { changed = true; return to; }
      if (key && JSON_LINK_KEYS.has(key) && linkRe.test(node)) { changed = true; return node.replace(linkRe, `$1${to}`); }
      return node;
    }
    if (Array.isArray(node)) {
      let any = false;
      const out = node.map(n => { const r = walk(n); if (r !== n) any = true; return r; });
      return any ? out : node;
    }
    if (node && typeof node === "object") {
      let any = false;
      const out = {};
      for (const [k, v] of Object.entries(node)) {
        const r = walk(v, k);
        if (r !== v) any = true;
        out[k] = r;
      }
      return any ? out : node;
    }
    return node;
  };

  const result = walk(value);
  return [result, changed];
}

/* -------------------------------------------------------------- database */

async function hasTable(table) {
  return await loopar.db.qx().schema.hasTable(table);
}

async function hasColumn(table, column) {
  return await loopar.db.qx().schema.hasColumn(table, column);
}

/** Tables (entity name → columns) that may store entity names. */
async function referenceTables() {
  const out = [];
  for (const ref of Object.values(loopar.getRefs(null, true) || {})) {
    if (ref.is_single || ref.is_virtual) continue;
    const table = ref.__NAME__;
    const columns = (ref.__FIELDS__ || []).filter(f => DB_NAME_COLUMNS.includes(f));
    if (!columns.length || !(await hasTable(table))) continue;
    out.push({ table, columns });
  }
  return out;
}

/**
 * The database part of a rename, for the current tenant. Idempotent: does
 * nothing once `from` is gone and `to` exists. Runs inside a transaction
 * opened by the caller (or opens its own).
 *   { type: "Page Builder", from: "Getting Started", to: "Ren Getting Started" }
 */
export async function applyRenameToDatabase({ type, from, to }) {
  const q = () => loopar.db.qx();
  const metaTable = type || "Entity";
  const report = { meta: 0, table: false, references: {} };

  if (!(await hasTable(metaTable))) return report;

  const existsOld = await q()(metaTable).where({ name: from }).first();
  const existsNew = await q()(metaTable).where({ name: to }).first();
  if (!existsOld && existsNew) return report; // already applied here
  if (existsOld && existsNew) {
    throw new Error(`Cannot rename ${metaTable} "${from}": "${to}" already exists in this tenant.`);
  }

  // 1. The meta row.
  if (existsOld) report.meta = await q()(metaTable).where({ name: from }).update({ name: to });

  // 2. The table (entities that own one). On a tenant replaying the rename,
  // the boot may already have created an empty table for the new name (the
  // files say it exists): drop that shell so the data table can take the name.
  // A non-empty one is a real conflict.
  if (await hasTable(from)) {
    if (await hasTable(to)) {
      const { c } = await q()(to).count({ c: "*" }).first();
      if (Number(c) > 0) {
        throw new Error(`Cannot rename table "${from}": "${to}" already exists with ${c} rows.`);
      }
      await q().schema.dropTable(to);
    }
    await q().schema.renameTable(from, to);
    report.table = true;
  }

  // 3. Columns that store entity names.
  const bump = (k, n) => { if (n) report.references[k] = (report.references[k] || 0) + n; };
  for (const { table, columns } of await referenceTables()) {
    for (const column of columns) {
      bump(`${table}.${column}`, await q()(table).where({ [column]: from }).update({ [column]: to }));
    }
  }

  // History / comments of the meta record itself: document = <type>, document_name = <name>.
  for (const table of ["Document History", "Comment"]) {
    if (await hasTable(table) && await hasColumn(table, "document_name")) {
      bump(`${table}.document_name`,
        await q()(table).where({ document: metaTable, document_name: from }).update({ document_name: to }));
    }
  }

  // Permission names embed the document: "Role-<role>-<document>-<action>".
  for (const table of ["Permission", "Role Permission"]) {
    if (!(await hasTable(table)) || !(await hasColumn(table, "document"))) continue;
    for (const row of await q()(table).select("id", "name").where({ document: to })) {
      const name = String(row.name || "");
      const renamed = name.replace(`-${from}-`, `-${to}-`);
      if (renamed !== name) bump(`${table}.name`, await q()(table).where({ id: row.id }).update({ name: renamed }));
    }
  }

  // 4. References inside every meta row's doc_structure.
  for (const table of metaTables()) {
    if (!(await hasTable(table)) || !(await hasColumn(table, "doc_structure"))) continue;
    const rows = await q()(table).select("id", "doc_structure").where("doc_structure", "like", `%${from}%`);
    for (const row of rows) {
      const [out, changed] = rewriteRefs({ doc_structure: row.doc_structure }, from, to);
      if (changed) bump(`${table}.doc_structure`, await q()(table).where({ id: row.id }).update({ doc_structure: out.doc_structure }));
    }
  }

  return report;
}

/* ----------------------------------------------------------------- files */

function listFiles(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

/** Every entity JSON and installer.json of every app (paths relative to the root). */
function appJsonFiles() {
  const out = [];
  for (const app of loopar.getApps()) {
    const appDir = abs(app.appRoot);
    const installer = path.join(appDir, "installer.json");
    if (fs.existsSync(installer)) out.push(installer);
    const walk = (dir, depth) => {
      for (const e of listFiles(dir)) {
        if (e.name === "node_modules" || e.name.startsWith(".")) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory() && depth < 5) walk(p, depth + 1);
        else if (e.isFile() && e.name.endsWith(".json") && path.basename(dir) + ".json" === e.name) out.push(p);
      }
    };
    walk(path.join(appDir, "modules"), 0);
  }
  return out;
}

/** Source files mentioning the old name as a string literal. */
function findCodeUsages(from) {
  const needles = [`"${from}"`, `'${from}'`, `\`${from}\``];
  const out = [];
  const roots = loopar.getApps().map(a => abs(a.appRoot));
  const walk = (dir, depth) => {
    for (const e of listFiles(dir)) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 8) walk(p, depth + 1);
      else if (e.isFile() && /\.(m?js|jsx|ts|tsx)$/.test(e.name)) {
        const lines = fs.readFileSync(p, "utf8").split("\n");
        lines.forEach((line, i) => {
          if (needles.some(n => line.includes(n))) out.push(`${path.relative(loopar.pathRoot, p)}:${i + 1}`);
        });
      }
    }
  };
  roots.forEach(r => walk(r, 0));
  return out;
}

/**
 * What a rename would do, without touching anything.
 * Throws on an invalid target name.
 */
export async function planRename(from, to) {
  to = String(to || "").trim();
  const ref = loopar.getRef(from);
  if (!ref) loopar.throw({ code: 404, message: `Entity "${from}" not found.` });

  const type = ref.__ENTITY__ || "Entity";
  if (NOT_RENAMABLE_TYPES.has(ref.__TYPE__)) loopar.throw(`${ref.__TYPE__} "${from}" can't be renamed.`);
  if (ref.__APP__ === "loopar" || ref.__APP__ === "core") loopar.throw(`"${from}" is a core entity and can't be renamed.`);

  if (!/^[A-Z][a-zA-Z0-9]*( [A-Z][a-zA-Z0-9]*)*$/.test(to) || to.length < 3 || to.length > 64) {
    loopar.throw(`"${to}" is not a valid entity name: words in PascalCase separated by single spaces, 3 to 64 characters.`);
  }
  if (loopar.utils.toEntityKey(to) === loopar.utils.toEntityKey(from)) {
    loopar.throw(`"${to}" is the same name as "${from}".`);
  }
  const clash = loopar.getRef(to);
  if (clash) loopar.throw(`"${to}" already exists (${clash.__ENTITY__} in app "${clash.__APP__}").`);

  const oldDir = abs(ref.__ROOT__);
  const newDir = path.join(path.dirname(oldDir), slugOf(to));
  if (fs.existsSync(newDir)) loopar.throw(`Folder ${path.relative(loopar.pathRoot, newDir)} already exists.`);

  const oldSlug = slugOf(from), newSlug = slugOf(to);
  const moves = [];
  for (const dir of [oldDir, path.join(oldDir, "client")]) {
    for (const e of listFiles(dir)) {
      if (!e.isFile()) continue;
      if (e.name.startsWith(`${oldSlug}.`) || e.name.startsWith(`${oldSlug}-`)) {
        moves.push([path.join(dir, e.name), path.join(dir, newSlug + e.name.slice(oldSlug.length))]);
      }
    }
  }

  const jsonFiles = appJsonFiles().filter(f => {
    const text = fs.readFileSync(f, "utf8");
    return text.includes(`"${from}"`) || text.includes(`/desk/${from}`) || text.includes(`\\"${from}\\"`);
  });

  return {
    type, from, to,
    app: ref.__APP__,
    ownsTable: !ref.is_single && !ref.is_virtual && ["Entity", "Builder", "Contact Form"].includes(ref.__TYPE__),
    folder: [path.relative(loopar.pathRoot, oldDir), path.relative(loopar.pathRoot, newDir)],
    files: moves.map(([a, b]) => [path.relative(loopar.pathRoot, a), path.relative(loopar.pathRoot, b)]),
    jsonFiles: jsonFiles.map(f => path.relative(loopar.pathRoot, f)),
    codeUsages: findCodeUsages(from),
    _abs: { oldDir, newDir, moves },
  };
}

function renameRecordFile(app) {
  return abs(loopar.makePath("apps", app, "renames.json"));
}

function appendRenameRecord(app, record) {
  const file = renameRecordFile(app);
  let list = [];
  try { list = JSON.parse(fs.readFileSync(file, "utf8")); } catch { list = []; }
  if (!Array.isArray(list)) list = [];
  list.push({ ...record, at: new Date().toISOString() });
  fs.writeFileSync(file, JSON.stringify(list, null, 2) + "\n");
}

/** Renames recorded by an app (replayed by the installer on update). */
export function readRenameRecords(appRoot) {
  try {
    const list = JSON.parse(fs.readFileSync(abs(path.join(appRoot, "renames.json")), "utf8"));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/**
 * Rename an entity: files, this tenant's database, references in every
 * app's JSON, the rename record, refs and the app's installer.
 * `dryRun: true` returns the plan only.
 */
export async function renameEntity(from, to, { dryRun = false } = {}) {
  const plan = await planRename(from, to);
  const { _abs, ...publicPlan } = plan;
  if (dryRun) return publicPlan;

  const { oldDir, newDir, moves } = _abs;
  const oldClass = classOf(from), newClass = classOf(to);
  const done = []; // [from, to] file moves, for rollback

  const undoFiles = () => {
    for (const [a, b] of done.reverse()) { try { fs.renameSync(b, a); } catch { /* best effort */ } }
  };

  // 1. Files: rename inside the old folder, then move the folder.
  try {
    for (const [a, b] of moves) { fs.renameSync(a, b); done.push([a, b]); }
    fs.renameSync(oldDir, newDir); done.push([oldDir, newDir]);
  } catch (e) {
    undoFiles();
    throw e;
  }

  // 2. This tenant's database, in one transaction.
  let report;
  try {
    await loopar.db.beginTransaction();
    report = await applyRenameToDatabase({ type: plan.type, from, to });
    await loopar.db.endTransaction();
  } catch (e) {
    await loopar.db.rollbackTransaction?.();
    undoFiles();
    throw e;
  }

  // 3. File contents: the entity's own JSON name, class names, references.
  const newSlug = slugOf(to);
  const ownJson = path.join(newDir, `${newSlug}.json`);
  if (fs.existsSync(ownJson)) {
    const data = JSON.parse(fs.readFileSync(ownJson, "utf8"));
    data.name = to;
    fs.writeFileSync(ownJson, JSON.stringify(data, null, 2));
  }
  for (const file of [path.join(newDir, `${newSlug}.js`), path.join(newDir, `${newSlug}-controller.js`)]) {
    if (!fs.existsSync(file)) continue;
    const src = fs.readFileSync(file, "utf8");
    const out = src.replace(new RegExp(`\\b${oldClass}(Controller)?\\b`, "g"), (_m, c) => newClass + (c || ""));
    if (out !== src) fs.writeFileSync(file, out);
  }
  const jsonUpdated = [];
  for (const rel of plan.jsonFiles) {
    const file = abs(rel).replace(oldDir, newDir);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    const [out, changed] = rewriteRefs(JSON.parse(text), from, to);
    if (changed) {
      fs.writeFileSync(file, JSON.stringify(out, null, text.includes('\n    "') ? 4 : 2));
      jsonUpdated.push(path.relative(loopar.pathRoot, file));
    }
  }

  // 4. Record it for the other tenants, refresh refs, rebuild the installer.
  appendRenameRecord(plan.app, { type: plan.type, from, to });
  await loopar.build();
  const app = await loopar.getDocument("App", plan.app, null, { ifNotFound: null });
  if (app) await app.bump("patch");

  return { ...publicPlan, database: report, jsonUpdated };
}
