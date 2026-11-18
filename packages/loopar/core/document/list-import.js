'use strict';

import { loopar } from '../loopar.js';
import { CREATED_BY_COLUMN } from '../global/audit.js';
import { isImportableField, importValue, MAX_IMPORT_ROWS, IMPORT_MODES } from '../global/list-import.js';

/**
 * Import of records into an entity (global/list-import.js). Every record goes
 * through the document — field policy, validation, hooks, naming — exactly as
 * if a person had typed it in the form; rows fail on their own, the rest go in.
 */
const MAX_ISSUES = 200;
const MAX_LINK_RECORDS = 20000;
const fold = (value) => String(value ?? '').trim().toLowerCase();
const plain = (message) => String(message ?? 'Could not be saved').replace(/<br\s*\/?>/gi, '; ').replace(/\s+/g, ' ').trim();

/** The entity a connection links to, or null. */
function linkedEntity(options) {
  const entity = typeof options === 'string' ? options.split(/\r?\n/)[0].trim() : '';
  return entity && loopar.getRef(entity, false) ? entity : null;
}

/**
 * Resolver of a connection's cells: the linked record's name as written, or
 * the record whose title reads like the cell (when exactly one does).
 */
async function linkResolver(entity) {
  const document = await loopar.newDocument(entity);
  const titleFields = document.getFieldSelectLabels().map((f) => f.trim()).filter((f) => f && f !== 'name');
  const rows = await loopar.db.qx()(entity).select(['name', ...titleFields]).limit(MAX_LINK_RECORDS + 1);
  const complete = rows.length <= MAX_LINK_RECORDS;

  const names = new Map();
  const titles = new Map();
  for (const row of rows) {
    names.set(fold(row.name), row.name);
    const title = fold(titleFields.map((f) => row[f]).filter((v) => v !== null && v !== undefined && v !== '').join(' - '));
    if (title) titles.set(title, titles.has(title) ? null : row.name);
  }

  return (text) => {
    const key = fold(text);
    if (names.has(key)) return { value: names.get(key) };
    if (titles.get(key)) return { value: titles.get(key) };
    if (titles.has(key)) return { issue: `several ${entity} records read "${text}": use the record's name` };
    // Too many records to know them all: let the document's own validation decide.
    return complete ? { issue: `"${text}" is not a ${entity}` } : { value: String(text).trim() };
  };
}

/**
 * Imports `records` (`[{ field: cell text }]`, in file order) into `entity`.
 *
 *   mode     "insert"  every row is a new record; a `name` that exists fails
 *            "upsert"  a row whose `name` exists updates that record (only the
 *                      cells that are not empty), any other row creates one
 *   dryRun   validate everything, write nothing
 *   updateOnly  (with "upsert") a row whose `name` doesn't exist fails
 *               instead of creating a record
 *
 * The acting user needs `create` to add and `update` to change (an 'own'
 * scope reaches only the records they created).
 *
 * → { total, created, updated, failed, issues: [{ row, message }], dry_run }
 *   `row` counts as the file does: the header is row 1.
 */
export async function importRecords(entity, { records = [], mode = 'insert', dryRun = false, updateOnly = false } = {}, user = loopar.auth?.user?.()) {
  const ref = loopar.getRef(entity, false);
  if (!ref || ref.is_single || ref.is_child || ref.is_virtual || ref.read_only) {
    loopar.throw({ code: 400, message: `${entity} does not take imported records.` });
  }
  if (!Array.isArray(records) || !records.length) loopar.throw({ code: 400, message: 'The file has no rows to import.' });
  if (records.length > MAX_IMPORT_ROWS) {
    loopar.throw({ code: 400, message: `An import takes up to ${MAX_IMPORT_ROWS} rows; this file has ${records.length}.` });
  }
  if (!IMPORT_MODES.includes(mode)) mode = 'insert';

  const { PermissionManager, SCOPE } = await import('../auth/PermissionManager.js');
  const createScope = PermissionManager.scope(entity, 'create', user);
  const updateScope = mode === 'upsert' ? PermissionManager.scope(entity, 'update', user) : null;

  const template = await loopar.newDocument(entity);
  const fields = {};
  for (const [name, field] of Object.entries(template.fields || {})) {
    const meta = { element: field.element, data: field };
    if (isImportableField(meta)) fields[name] = meta;
  }

  const resolvers = {};
  const resolveLink = async (name, text) => {
    const linked = linkedEntity(fields[name].data.options);
    if (!linked) return { value: text };
    resolvers[name] ??= await linkResolver(linked);
    return resolvers[name](text);
  };

  const result = { total: records.length, created: 0, updated: 0, failed: 0, issues: [], dry_run: !!dryRun };
  const fail = (index, message) => {
    result.failed++;
    if (result.issues.length < MAX_ISSUES) result.issues.push({ row: index + 2, message: plain(message) });
  };

  for (let index = 0; index < records.length; index++) {
    const record = records[index] && typeof records[index] === 'object' ? records[index] : {};
    const values = {};
    const issues = [];

    for (const [name, raw] of Object.entries(record)) {
      const field = fields[name];
      if (!field) continue;
      const text = String(raw ?? '').trim();
      // An empty cell says nothing: defaults stay on a new record, stored values on an existing one.
      if (text === '') continue;

      let cell = importValue(text, field);
      if (!cell.issue && field.element === CONNECTION) {
        cell = [1, '1', true, 'true'].includes(field.data.multiple) ? cell : await resolveLink(name, text);
      }
      cell.issue ? issues.push(`${field.data.label || name}: ${cell.issue}`) : (values[name] = cell.value);
    }

    if (issues.length) { fail(index, issues.join('; ')); continue; }
    if (!Object.keys(values).length) { fail(index, 'The row is empty.'); continue; }

    try {
      const name = values.name;
      const audit = await ownerColumn(entity);
      let lookup = name ? loopar.db.qx()(entity).where({ name }) : null;
      // A deleted record's name is free again.
      if (lookup && audit.length) lookup = lookup.whereNull('__deleted_at__');
      const existing = lookup ? await lookup.first('name', ...audit) : null;

      if (existing) {
        if (mode !== 'upsert') { fail(index, `${entity} ${name} already exists.`); continue; }
        if (!updateScope) { fail(index, 'You do not have permission to update records.'); continue; }
        if (updateScope !== SCOPE.ALL && !(updateScope === SCOPE.OWN && existing[CREATED_BY_COLUMN] === user)) {
          fail(index, 'You do not have permission over this record.');
          continue;
        }
        const { name: _key, ...changes } = values;
        const document = await loopar.getDocument(entity, name, changes);
        dryRun ? await document.validate() : await document.save();
        result.updated++;
      } else {
        if (updateOnly) { fail(index, `${entity} ${name ?? ''} not found.`); continue; }
        if (!createScope) { fail(index, 'You do not have permission to create records.'); continue; }
        const document = await loopar.newDocument(entity, values);
        // A record without a name gets one when it is saved (naming series).
        dryRun ? await document.validate({ skipName: !name }) : await document.save();
        result.created++;
      }
    } catch (e) {
      fail(index, e?.message || e);
    }
  }

  return result;
}

const ownerColumns = new Map();
/** `[__created_by__]` when the table has it (cached per tenant and entity). */
async function ownerColumn(entity) {
  const key = `${loopar.tenantId ?? ''}::${entity}`;
  if (!ownerColumns.has(key)) {
    let has = false;
    try { has = (await loopar.db.getTableColumns(entity)).has(CREATED_BY_COLUMN); } catch { has = false; }
    ownerColumns.set(key, has ? [CREATED_BY_COLUMN] : []);
  }
  return ownerColumns.get(key);
}
