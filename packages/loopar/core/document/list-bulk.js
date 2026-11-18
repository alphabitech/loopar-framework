'use strict';

import { loopar } from '../loopar.js';
import { importRecords } from './list-import.js';
import { isImportableField } from '../global/list-import.js';
import { applyTransition } from './workflow.js';

/**
 * Bulk actions on the records selected in a list. Like the import, every
 * record goes through its document and fails on its own.
 *
 * → { total, done, failed, issues: [{ name, message }] }
 */
export const MAX_BULK_RECORDS = 500;

function pickNames(names) {
  const list = [...new Set((Array.isArray(names) ? names : []).map((n) => String(n ?? '').trim()).filter(Boolean))];
  if (!list.length) loopar.throw({ code: 400, message: 'Select at least one record.' });
  if (list.length > MAX_BULK_RECORDS) {
    loopar.throw({ code: 400, message: `A bulk action takes up to ${MAX_BULK_RECORDS} records at a time.` });
  }
  return list;
}

/**
 * Sets one field to the same value on every record of `names`. The field
 * must be one a person may edit (an importable field that is not the name
 * and not write-once); the value is read as an import cell is (an option's
 * label, a linked record's title, yes / no…).
 */
export async function bulkUpdateRecords(entity, { names, field, value } = {}, user = loopar.auth?.user?.()) {
  const list = pickNames(names);
  const template = await loopar.newDocument(entity);
  const meta = template.fields?.[field];
  const editable = meta && field !== 'name' && meta.write_policy !== 'create_only'
    && isImportableField({ element: meta.element, data: meta });
  if (!editable) loopar.throw({ code: 400, message: `Field "${field}" can't be edited in bulk.` });
  if (String(value ?? '').trim() === '' && ![SWITCH, CHECKBOX].includes(meta.element)) {
    loopar.throw({ code: 400, message: 'A bulk edit needs a value.' });
  }

  const result = await importRecords(entity, {
    mode: 'upsert',
    updateOnly: true,
    records: list.map((name) => ({ name, [field]: value })),
  }, user);

  return {
    total: result.total,
    done: result.updated,
    failed: result.failed,
    issues: result.issues.map((issue) => ({ name: list[issue.row - 2], message: issue.message })),
  };
}

/**
 * Runs the workflow transition `action` on every record of `names`. A record
 * whose state doesn't offer it (or that the user's roles can't move) fails
 * on its own.
 */
export async function bulkTransitionRecords(entity, { names, action } = {}) {
  const list = pickNames(names);
  if (!action) loopar.throw({ code: 400, message: 'Pick the action to run.' });

  const result = { total: list.length, done: 0, failed: 0, issues: [] };
  for (const name of list) {
    try {
      await applyTransition(await loopar.getDocument(entity, name), String(action));
      result.done++;
    } catch (e) {
      result.failed++;
      result.issues.push({ name, message: String(e?.message || e).replace(/<br\s*\/?>/gi, '; ') });
    }
  }
  return result;
}
