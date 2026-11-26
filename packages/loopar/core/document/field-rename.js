'use strict';

/**
 * References to a field by its name, rewritten when the field is renamed.
 * A renamed field's values move with its data migration (renameColumn); the
 * places that name it move here:
 *
 *   the entity itself   formulas, display/required conditions, the cascade
 *                       `parent` of its connections, title and search fields
 *   other entities      connections pointing to it (their `filters`,
 *                       `group_by`, `parent_filter` name its fields) and
 *                       formulas reading through them (`customer.email`)
 *   each tenant's data  per-user list settings, saved views, workflows
 *                       (state field, required fields of a transition)
 *
 * Files (the entities' JSON, shared by every tenant) are rewritten by the
 * designer once; each tenant's database by the migration
 * (migrate.renameFieldReferences), so every site follows at its update.
 * Names written in code are never rewritten: they are reported.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loopar } from '../loopar.js';
import { fileManage } from '../file-manage.js';

const ID_START = /[A-Za-z_]/;

/**
 * Rewrite identifier paths in an expression, outside quoted strings.
 * `map(path)` gets each dotted identifier path ("qty", "customer.email")
 * and returns its replacement, or null to keep it.
 */
export function rewriteIdentifiers(expr, map) {
  if (typeof expr !== 'string' || !expr) return expr;
  let out = '';
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < expr.length && expr[j] !== ch) j += expr[j] === '\\' ? 2 : 1;
      out += expr.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    const prev = i > 0 ? expr[i - 1] : '';
    if (ID_START.test(ch) && !/[\w.]/.test(prev)) {
      let j = i;
      while (j < expr.length && /[\w.]/.test(expr[j])) j++;
      const ident = expr.slice(i, j);
      out += map(ident) ?? ident;
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

const firstLine = (v) => String(v || '').split(/\r?\n/)[0].trim();
const renameInList = (list, from, to) => {
  if (typeof list !== 'string' || !list) return list;
  const parts = list.split(',').map((s) => s.trim());
  return parts.includes(from) ? parts.map((p) => (p === from ? to : p)).join(',') : list;
};

/**
 * Rewrite one structure (a doc_structure, parsed). `self`: the structure is
 * the renamed field's own entity. Returns [structure, changed].
 */
export function renameFieldInStructure(structure, { entity, from, to, self }) {
  let changed = false;
  const set = (data, key, value) => {
    if (value !== data[key]) { data[key] = value; changed = true; }
  };

  // Connections of this structure that point to the renamed field's entity.
  const linksToEntity = new Set();
  const collect = (els = []) => {
    for (const el of els) {
      if (el?.element === 'connection' && el.data?.name && firstLine(el.data.options) === entity) linksToEntity.add(el.data.name);
      collect(el?.elements);
    }
  };
  collect(structure);

  const mapPath = (p) => {
    const [head, ...rest] = p.split('.');
    // Own field (or a path starting at it: a renamed connection's `customer.email`).
    if (self && head === from) return [to, ...rest].join('.');
    // A field of the entity, read through a connection pointing to it.
    if (rest.length === 1 && linksToEntity.has(head) && rest[0] === from) return `${head}.${to}`;
    return null;
  };

  const walk = (els = []) => {
    for (const el of els) {
      const data = el?.data;
      if (data) {
        for (const key of ['formula', 'display_on', 'required_on']) {
          if (typeof data[key] === 'string') set(data, key, rewriteIdentifiers(data[key], mapPath));
        }
        if (self && data.parent === from) set(data, 'parent', to);
        // A connection to the entity names the entity's fields in its options.
        if (el.element === 'connection' && firstLine(data.options) === entity) {
          if (data.group_by === from) set(data, 'group_by', to);
          if (data.parent_filter === from) set(data, 'parent_filter', to);
          if (typeof data.filters === 'string') set(data, 'filters', rewriteIdentifiers(data.filters, (p) => (p === from ? to : null)));
        }
      }
      walk(el?.elements);
    }
  };
  walk(structure);
  return [structure, changed];
}

/** An entity record (or its JSON): its structure and the field lists naming its own fields. */
export function renameFieldInEntityRecord(record, { entity, from, to }) {
  const self = record.name === entity;
  const raw = record.doc_structure;
  const parsed = typeof raw === 'string' ? (loopar.utils.isJSON(raw) ? JSON.parse(raw) : null) : raw;
  let changed = false;
  if (Array.isArray(parsed)) {
    const [, structureChanged] = renameFieldInStructure(parsed, { entity, from, to, self });
    if (structureChanged) {
      record.doc_structure = typeof raw === 'string' ? JSON.stringify(parsed) : parsed;
      changed = true;
    }
  }
  if (self) {
    for (const key of ['title_fields', 'search_fields']) {
      const next = renameInList(record[key], from, to);
      if (next !== record[key]) { record[key] = next; changed = true; }
    }
  }
  return changed;
}

/* ----------------------------------------------------------------- files */

/**
 * Designer: rewrite the JSON files of the OTHER entities that name the field
 * (the renamed field's own entity is being saved with its new structure).
 * @returns {Array<{ file, path, original }>} files changed (`original`: to put back if the save fails)
 */
export function renameFieldInFiles({ entity, from, to }) {
  const changed = [];
  for (const ref of Object.values(loopar.getRefs?.() || {})) {
    if (!ref?.__ROOT__ || !ref.__NAME__ || ref.__NAME__ === entity) continue;
    const file = loopar.makePath(loopar.pathRoot, ref.__ROOT__, `${fileNameOf(ref.__NAME__)}.json`);
    if (!fs.existsSync(file)) continue;
    let json;
    try { json = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    const original = fs.readFileSync(file, 'utf8');
    if (!renameFieldInEntityRecord(json, { entity, from, to })) continue;
    fs.writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
    changed.push({ file: path.relative(loopar.pathRoot, file), path: file, original });
  }
  return changed;
}

const fileNameOf = (name) => fileManage.folderName(name);

/**
 * Code that may name the field (`'from'`, `.from`), in files that also name
 * the entity: reported to the developer, never rewritten.
 */
export function fieldCodeUsages({ entity, from }) {
  const usages = [];
  const word = new RegExp(`(['"\`])${from}\\1|\\.${from}\\b`);
  const roots = (loopar.getApps?.() || []).map((a) => loopar.makePath(loopar.pathRoot, a.appRoot));
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|jsx|mjs)$/.test(e.name) && !/[\\/]migrations[\\/]/.test(p)) {
        const text = fs.readFileSync(p, 'utf8');
        if (!text.includes(entity) || !word.test(text)) continue;
        text.split('\n').forEach((line, i) => {
          if (word.test(line)) usages.push(`${path.relative(loopar.pathRoot, p)}:${i + 1}`);
        });
      }
    }
  };
  roots.forEach(walk);
  return usages.slice(0, 50);
}

/* -------------------------------------------------------------- database */

/**
 * A saved view's URL query: a filter on the field (its key) is renamed; in
 * the other keys that aren't fields (sort, group, columns…) the field's name
 * as a whole word is.
 */
const renameInQuery = (query, from, to, fields) => {
  if (typeof query !== 'string' || !query) return query;
  const params = new URLSearchParams(query.replace(/^\?/, ''));
  const out = new URLSearchParams();
  const tokenRe = new RegExp(`(^|[\\s,:|+-])${from}(?=$|[\\s,:|.])`, 'g');
  let changed = false;
  for (const [key, value] of params) {
    let k = key;
    let v = value;
    if (key === from || key.startsWith(`${from}.`) || key.startsWith(`${from}__`)) k = to + key.slice(from.length);
    else if (!fields.has(key)) v = value.replace(tokenRe, `$1${to}`);
    if (k !== key || v !== value) changed = true;
    out.append(k, v);
  }
  return changed ? out.toString() : query;
};

const renameInListSettings = (json, from, to) => {
  const s = loopar.utils.JSONparse(json, null);
  if (!s || typeof s !== 'object') return json;
  const swap = (v) => (v === from ? to : v);
  for (const key of ['order', 'hidden', 'shown']) if (Array.isArray(s[key])) s[key] = s[key].map(swap);
  if (s.widths && from in s.widths) { s.widths[to] = s.widths[from]; delete s.widths[from]; }
  if (Array.isArray(s.sort)) s.sort = s.sort.map((x) => (x?.field === from ? { ...x, field: to } : x));
  const next = JSON.stringify(s);
  return next === JSON.stringify(loopar.utils.JSONparse(json, null)) ? json : next;
};

/**
 * One tenant's database: the entity records of every type (other entities'
 * structures, the entity's own title/search fields) and the data that names
 * fields. Each tenant runs it from the migration. Returns what changed.
 */
export async function renameFieldReferencesInDatabase({ entity, from, to }, db = loopar.db) {
  const q = db.qx();
  const report = {};
  const bump = (k) => { report[k] = (report[k] || 0) + 1; };
  const hasTable = async (t) => { try { return await q.schema.hasTable(t); } catch { return false; } };

  // Entity records (Entity, and every builder type with its own table).
  const metaTables = [...new Set(['Entity', ...Object.keys(loopar.getTypes?.() || {})])];
  for (const table of metaTables) {
    if (!(await hasTable(table))) continue;
    const cols = new Set((await db.getTableDescription(table)).map((c) => c.name));
    if (!cols.has('doc_structure')) continue;
    const pick = ['name', 'doc_structure', ...['title_fields', 'search_fields'].filter((c) => cols.has(c))];
    for (const row of await q(table).select(pick)) {
      const record = { ...row };
      if (!renameFieldInEntityRecord(record, { entity, from, to })) continue;
      const patch = {};
      for (const k of pick.slice(1)) if (record[k] !== row[k]) patch[k] = record[k];
      await q(table).where({ name: row.name }).update(patch);
      bump(`${table} structures`);
    }
  }

  if (await hasTable('List View Setting')) {
    for (const row of await q('List View Setting').where({ target_entity: entity }).select('name', 'settings_json')) {
      const next = renameInListSettings(row.settings_json, from, to);
      if (next !== row.settings_json) { await q('List View Setting').where({ name: row.name }).update({ settings_json: next }); bump('list settings'); }
    }
  }
  const fields = new Set([...(loopar.getRef(entity, false)?.__FIELDS__ || []), from, to].map(String));
  if (await hasTable('Saved View')) {
    for (const row of await q('Saved View').where({ target_entity: entity }).select('name', 'query')) {
      const next = renameInQuery(row.query, from, to, fields);
      if (next !== row.query) { await q('Saved View').where({ name: row.name }).update({ query: next }); bump('saved views'); }
    }
  }
  if (await hasTable('Workflow')) {
    const flows = await q('Workflow').where({ document: entity }).select('id', 'name', 'state_field');
    for (const flow of flows) {
      if (flow.state_field === from) { await q('Workflow').where({ name: flow.name }).update({ state_field: to }); bump('workflows'); }
      if (await hasTable('Workflow Transition')) {
        const parents = [flow.name, flow.id].filter((v) => v != null).map(String);
        for (const t of await q('Workflow Transition').where({ parent_document: 'Workflow' }).whereIn('parent_id', parents).select('name', 'required_fields')) {
          const next = renameInList(t.required_fields, from, to);
          if (next !== t.required_fields) { await q('Workflow Transition').where({ name: t.name }).update({ required_fields: next }); bump('workflow transitions'); }
        }
      }
    }
  }
  return report;
}
