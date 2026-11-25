'use strict';

/**
 * Submittable entities (Entity flag `is_submittable`): a record is drafted,
 * then submitted, then — if it must go — cancelled, and a cancelled record is
 * amended into a new draft (`INV-001` → `INV-001-1`). The state lives in
 * `__document_status__` (DOC_STATUS.DRAFT / SUBMITTED / CANCELLED).
 *
 *   - Draft:     edited and deleted freely.
 *   - Submitted: locked — only fields marked "Editable after submit"
 *                (`allow_on_submit`) change; it can't be deleted, only cancelled.
 *                It may only point to submitted records of submittable entities.
 *   - Cancelled: locked and never deleted; amended into a new draft.
 *
 * Child rows follow their parent: a locked parent's rows can't be written.
 *
 * Enforced in the ORM write pipeline (KnexORM before* events, like
 * referential-integrity.js), so no path that writes through the ORM can
 * edit, delete or re-status a locked record. The steps themselves (submit,
 * cancel, amend) run inside `withLifecycle`. In "warn" integrity mode the
 * refusals are only logged.
 *
 * Models can hook in with beforeSubmit/afterSubmit, beforeCancel/afterCancel
 * and beforeAmend(copy)/afterAmend(copy). With a workflow, a Workflow State
 * whose "Document status" is Submitted or Cancelled submits / cancels the
 * record when a transition enters it; other transitions on a submitted record
 * may change the state field, the transition's required fields and the
 * allow_on_submit fields.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { loopar } from '../loopar.js';
import { DOC_STATUS, coerceDocStatus, AMENDED_FROM_COLUMN, AUDIT_COLUMN_SET, CHILD_POSITION_COLUMN } from '../global/audit.js';
import { multipleValues } from '../global/element-definition.js';
import { violation } from '../global/integrity-mode.js';
import { linkIndex, referenceChecksOff, connectedDocuments } from './referential-integrity.js';
import { PermissionManager } from '../auth/PermissionManager.js';

export const LIFECYCLE = Object.freeze({ DRAFT: 'Draft', SUBMITTED: 'Submitted', CANCELLED: 'Cancelled' });
const COLORS = { Draft: 'gray', Submitted: 'blue', Cancelled: 'red' };

const scope = new AsyncLocalStorage();

/**
 * Runs `fn` as a lifecycle step. `fields`: what may change on a locked record
 * during it (a workflow transition); none given = anything (submit, cancel, amend).
 */
export function withLifecycle(fn, { fields = null } = {}) {
  return scope.run({ fields: fields ? new Set(fields) : null }, fn);
}

const fullStep = () => { const s = scope.getStore(); return !!s && s.fields === null; };
const key = (name) => loopar.utils.toEntityKey(name);

export const isSubmittable = (entity) => !!loopar.getRef(entity, false)?.is_submittable;

/** "Draft" | "Submitted" | "Cancelled" from a stored __document_status__. */
export function lifecycleStatus(value) {
  const status = coerceDocStatus(value);
  if (status === DOC_STATUS.SUBMITTED) return LIFECYCLE.SUBMITTED;
  if (status === DOC_STATUS.CANCELLED) return LIFECYCLE.CANCELLED;
  return LIFECYCLE.DRAFT;
}

const isLocked = (value) => lifecycleStatus(value) !== LIFECYCLE.DRAFT;

/** Fields of `entity` marked "Editable after submit". */
export function allowOnSubmitFields(entity) {
  const meta = loopar.getRef(entity, false)?.__FIELD_META__ || {};
  return new Set(Object.keys(meta).filter((name) => meta[name].allow_on_submit));
}

/** Fields shown read-only for a record in `status` (null: none). */
export function lockedFieldNames(entity, status) {
  if (status === LIFECYCLE.DRAFT) return null;
  const meta = loopar.getRef(entity, false)?.__FIELD_META__ || {};
  const open = status === LIFECYCLE.SUBMITTED ? allowOnSubmitFields(entity) : new Set();
  return Object.keys(meta).filter((name) => !open.has(name));
}

// Columns the framework writes on its own (timestamps, version, position).
const FRAMEWORK = new Set(['id', 'name', 'parent_document', 'parent_id', CHILD_POSITION_COLUMN, ...AUDIT_COLUMN_SET]);

const pad = (n) => String(n).padStart(2, '0');
function comparable(v) {
  if (v === null || v === undefined || v === '') return '';
  if (v === true) return '1';
  if (v === false) return '0';
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return '';
    const midnight = !v.getHours() && !v.getMinutes() && !v.getSeconds() && !v.getMilliseconds();
    return midnight ? `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}` : `t${v.getTime()}`;
  }
  if (typeof v === 'object') return JSON.stringify(v);
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(s)) {
    const t = new Date(s.replace(' ', 'T')).getTime();
    if (!Number.isNaN(t)) return `t${t}`;
  }
  if (s !== '' && Number.isFinite(Number(s))) return `n${Number(s)}`;
  return s;
}
const sameValue = (a, b) => comparable(a) === comparable(b);

/** The parent's form table of `childEntity` is marked "Editable after submit". */
function childTableOpen(parentEntity, childEntity) {
  const meta = loopar.getRef(parentEntity, false)?.__FIELD_META__ || {};
  return Object.values(meta).some((m) => m.element === FORM_TABLE && m.allow_on_submit && key(m.options || '') === key(childEntity));
}

/** A locked submittable parent of a child row being written, or null. */
async function lockedParent(db, childEntity, row, name) {
  const parents = (linkIndex().childParents.get(key(childEntity)) || []).filter(isSubmittable);
  if (!parents.length) return null;

  let parentDocument = row?.parent_document, parentId = row?.parent_id;
  if ((parentDocument == null || parentId == null) && name != null) {
    const stored = await db.qx()(childEntity).where({ name }).first(['parent_document', 'parent_id']);
    parentDocument ??= stored?.parent_document;
    parentId ??= stored?.parent_id;
  }
  if (!parentDocument || parentId == null || !isSubmittable(parentDocument)) return null;

  const parent = await db.qx()(parentDocument).where({ id: parentId }).first(['name', '__document_status__']);
  if (!parent || !isLocked(parent.__document_status__)) return null;
  const status = lifecycleStatus(parent.__document_status__);
  // A table marked "Editable after submit" (payments of an invoice) stays open while Submitted.
  if (status === LIFECYCLE.SUBMITTED && childTableOpen(parentDocument, childEntity)) return null;
  return { entity: parentDocument, name: parent.name, status };
}

const childRefusal = (parent) => ({
  ...VALIDATION_ERROR,
  message: `${parent.entity} ${parent.name} is ${parent.status}: its rows can't be changed.`,
});

/** Called before child rows a document no longer sends are removed (they skip the ORM). */
export async function assertChildRowsWritable(parentEntity, parentName, childEntity = null) {
  if (referenceChecksOff() || fullStep() || !isSubmittable(parentEntity)) return;
  const row = await loopar.db.qx()(parentEntity).where({ name: parentName }).first('__document_status__');
  if (!row || !isLocked(row.__document_status__)) return;
  const status = lifecycleStatus(row.__document_status__);
  if (status === LIFECYCLE.SUBMITTED && childEntity && childTableOpen(parentEntity, childEntity)) return;
  violation(childRefusal({ entity: parentEntity, name: parentName, status }));
}

// ── ORM guards ──────────────────────────────────────────────────────────────
async function onCreate({ db, document, doc }) {
  if (!doc || referenceChecksOff()) return;
  // A new record starts as a Draft, whatever the payload says.
  if (isSubmittable(document) && !fullStep()) {
    doc.__document_status__ = DOC_STATUS.DRAFT;
    delete doc[AMENDED_FROM_COLUMN];
  }
  if (fullStep()) return;
  const parent = await lockedParent(db, document, doc, null);
  if (parent) violation(childRefusal(parent));
}

async function onUpdate({ db, document, name, doc, before }) {
  if (!doc || referenceChecksOff() || fullStep()) return;
  const step = scope.getStore();

  if (isSubmittable(document)) {
    const prev = before || (name != null ? await db.qx()(document).where({ name }).first() : null);
    if (prev) {
      const status = lifecycleStatus(prev.__document_status__);
      if ('__document_status__' in doc && coerceDocStatus(doc.__document_status__) !== coerceDocStatus(prev.__document_status__)) {
        violation({ ...VALIDATION_ERROR, message: `${document} ${name}: its status changes only through Submit, Cancel and Amend.` });
      }
      if (doc[AMENDED_FROM_COLUMN] !== undefined && !sameValue(doc[AMENDED_FROM_COLUMN], prev[AMENDED_FROM_COLUMN])) {
        violation({ ...VALIDATION_ERROR, message: `${document} ${name}: "amended from" is set by Amend only.` });
      }
      if (status !== LIFECYCLE.DRAFT) {
        const open = new Set([...(status === LIFECYCLE.SUBMITTED ? allowOnSubmitFields(document) : []), ...(step?.fields || [])]);
        const changed = Object.keys(doc).filter((k) => !FRAMEWORK.has(k) && k in prev && !open.has(k) && !sameValue(doc[k], prev[k]));
        if (changed.length) {
          violation({
            ...VALIDATION_ERROR,
            message: status === LIFECYCLE.SUBMITTED
              ? `${document} ${name} is Submitted: ${changed.join(', ')} can't be changed. Cancel and amend it to correct it.`
              : `${document} ${name} is Cancelled: it can't be changed. Amend it to make a corrected copy.`,
          });
        }
      }
    }
  }

  const parent = await lockedParent(db, document, doc, name);
  if (parent) violation(childRefusal(parent));
}

async function onDelete({ db, document, doc }) {
  const name = doc?.name;
  if (name == null || referenceChecksOff() || fullStep()) return;

  if (isSubmittable(document)) {
    const row = await db.qx()(document).where({ name }).first('__document_status__');
    const status = row ? lifecycleStatus(row.__document_status__) : LIFECYCLE.DRAFT;
    if (status === LIFECYCLE.SUBMITTED) {
      violation({ ...VALIDATION_ERROR, message: `${document} ${name} is Submitted: it can't be deleted. Cancel it instead.` });
    } else if (status === LIFECYCLE.CANCELLED) {
      violation({ ...VALIDATION_ERROR, message: `${document} ${name} is Cancelled: it is kept as a record and can't be deleted.` });
    }
  }

  const parent = await lockedParent(db, document, doc, name);
  if (parent) violation(childRefusal(parent));
}

let wired = false;

/** Called once at boot, before setupReferentialIntegrity (the state is checked first). */
export function setupDocumentLifecycle(KnexORM) {
  if (wired) return;
  wired = true;
  KnexORM.on('beforeCreate', onCreate);
  KnexORM.on('beforeUpdate', onUpdate);
  KnexORM.on('beforeDelete', onDelete);
}

// ── Steps ───────────────────────────────────────────────────────────────────
async function storedStatus(doc) {
  const row = await loopar.db.qx()(doc.__ENTITY__.name).where({ name: doc.__DOCUMENT_NAME__ ?? doc.name }).first('__document_status__');
  return row ? lifecycleStatus(row.__document_status__) : LIFECYCLE.DRAFT;
}

function assertSubmittable(doc) {
  const entity = doc.__ENTITY__?.name;
  if (!isSubmittable(entity)) loopar.throw({ ...VALIDATION_ERROR, message: `${entity} is not submittable.` });
  return entity;
}

/** Every record a submitted one points to, in a submittable entity, must be submitted too. */
async function assertLinksSubmitted(doc) {
  const entity = doc.__ENTITY__.name;
  const errors = [];
  for (const link of linkIndex().outgoing.get(key(entity)) || []) {
    if (!isSubmittable(link.target)) continue;
    const raw = doc[link.field];
    const values = link.multiple ? multipleValues(raw) : (raw == null || raw === '' ? [] : [String(raw)]);
    if (!values.length) continue;
    const rows = await loopar.db.qx()(link.target).whereIn('name', values).select('name', '__document_status__');
    for (const row of rows) {
      const status = lifecycleStatus(row.__document_status__);
      if (status !== LIFECYCLE.SUBMITTED) errors.push(`${link.field}: ${link.target} ${row.name} is ${status}; it must be submitted first.`);
    }
  }
  if (errors.length) loopar.throw({ ...VALIDATION_ERROR, message: errors.join('<br/>') });
}

/** Writes the record's lifecycle status behind the instance, which adopts the new version (its next save is not stale). */
async function setStatus(doc, status, extra = {}) {
  await loopar.db.updateRow(doc.__ENTITY__.name, doc.__DOCUMENT_NAME__ ?? doc.name, { __document_status__: status, ...extra });
  await doc.syncVersion?.();
}

/**
 * Runs a step: in a transaction, inside the lifecycle scope, with
 * `doc.__LIFECYCLE__` naming it ("Submit" | "Cancel" | "Amend") so the
 * model's own beforeSave can tell a step from an edit.
 */
async function step(doc, action, fn) {
  return await loopar.db.withTransaction(() => withLifecycle(async () => {
    const previous = doc.__LIFECYCLE__;
    doc.__LIFECYCLE__ = action;
    try { return await fn(); } finally { doc.__LIFECYCLE__ = previous; }
  }));
}

/**
 * Draft → Submitted. beforeSubmit(options) runs first (it may set fields),
 * then the record is saved (a new one is created), its links are checked and
 * it is marked Submitted; afterSubmit(options) runs last, in the same transaction.
 */
export async function submitDocument(doc, options = {}) {
  const entity = assertSubmittable(doc);
  return await step(doc, 'Submit', async () => {
    if (!doc.__IS_NEW__) {
      const status = await storedStatus(doc);
      if (status !== LIFECYCLE.DRAFT) loopar.throw({ ...VALIDATION_ERROR, message: `${entity} ${doc.name} is ${status}: only a Draft can be submitted.` });
    }
    if (typeof doc.beforeSubmit === 'function') await doc.beforeSubmit(options);
    await doc.save();
    await assertLinksSubmitted(doc);
    await setStatus(doc, DOC_STATUS.SUBMITTED);
    doc.__document_status__ = DOC_STATUS.SUBMITTED;
    if (typeof doc.afterSubmit === 'function') await doc.afterSubmit(options);
    return { name: doc.name, status: LIFECYCLE.SUBMITTED };
  });
}

/**
 * Submitted → Cancelled. beforeCancel(options) runs first — it undoes what
 * the record did (reversals, rows it wrote elsewhere) and may save it — then
 * the cancel is refused while a submitted record of a submittable entity
 * still points to it (cancel that one first). `save`: write the document's
 * pending changes in the same step (a workflow transition).
 */
export async function cancelDocument(doc, options = {}) {
  const entity = assertSubmittable(doc);
  const { save = false } = options;
  return await step(doc, 'Cancel', async () => {
    const status = await storedStatus(doc);
    if (status !== LIFECYCLE.SUBMITTED) loopar.throw({ ...VALIDATION_ERROR, message: `${entity} ${doc.name} is ${status}: only a submitted record can be cancelled.` });

    if (typeof doc.beforeCancel === 'function') await doc.beforeCancel(options);

    const blockers = [];
    for (const c of await connectedDocuments(loopar.db, entity, doc.name, { limit: 50 })) {
      if (!isSubmittable(c.entity) || key(c.entity) === key(entity) && c.name === doc.name) continue;
      const row = await loopar.db.qx()(c.entity).where({ name: c.name }).first('__document_status__');
      if (row && lifecycleStatus(row.__document_status__) === LIFECYCLE.SUBMITTED) blockers.push(c);
    }
    if (blockers.length) {
      loopar.throw({
        ...VALIDATION_ERROR,
        message: `<h2>${entity} ${doc.name} can't be cancelled while these submitted records point to it — cancel them first:</h2><br/>` +
          blockers.map((b, i) => `<a href='/desk/${b.entity}/update?name=${encodeURIComponent(b.name)}'>${i + 1}: <strong>${b.entity}</strong>.${b.name}</a>`).join('<br/>'),
      });
    }

    if (save) await doc.save();
    await setStatus(doc, DOC_STATUS.CANCELLED);
    doc.__document_status__ = DOC_STATUS.CANCELLED;
    if (typeof doc.afterCancel === 'function') await doc.afterCancel(options);
    return { name: doc.name, status: LIFECYCLE.CANCELLED };
  });
}

/**
 * The name of the next version of `name` (INV-001 → INV-001-1 → INV-001-2).
 * `isVersion`: `name` is itself a version (it was amended or supersedes one),
 * so its suffix is the one that grows.
 */
export async function versionName(entity, name, isVersion = false) {
  const m = isVersion ? /^(.*)-(\d+)$/.exec(String(name)) : null;
  const base = m ? m[1] : String(name);
  let n = m ? Number(m[2]) + 1 : 1;
  while (await loopar.db.qx()(entity).where({ name: `${base}-${n}` }).first('id')) n++;
  return `${base}-${n}`;
}

/**
 * A new record with the values and child rows of `doc` (not its framework
 * columns nor passwords), named `name`. Not saved.
 */
export async function copyDocument(doc, name) {
  const entity = doc.__ENTITY__.name;
  const meta = loopar.getRef(entity, false)?.__FIELD_META__ || {};
  const values = await doc.rawValues();
  for (const field of Object.keys(values)) {
    if (FRAMEWORK.has(field) || meta[field]?.element === PASSWORD) delete values[field];
  }
  return await loopar.newDocument(entity, { ...values, name });
}

/**
 * Cancelled → a new Draft copy (child rows included) that remembers where it
 * came from. beforeAmend(copy, options) adjusts the copy before it is saved
 * (a model may give it a number of its own); afterAmend(copy, options) runs after.
 */
export async function amendDocument(doc, options = {}) {
  const entity = assertSubmittable(doc);
  const status = await storedStatus(doc);
  if (status !== LIFECYCLE.CANCELLED) loopar.throw({ ...VALIDATION_ERROR, message: `${entity} ${doc.name} is ${status}: only a cancelled record can be amended.` });

  const copy = await copyDocument(doc, await versionName(entity, doc.name, !!doc[AMENDED_FROM_COLUMN]));

  await step(doc, 'Amend', async () => {
    copy.__LIFECYCLE__ = 'Amend';
    try {
      if (typeof doc.beforeAmend === 'function') await doc.beforeAmend(copy, options);
      await copy.save();
      await setStatus(copy, DOC_STATUS.DRAFT, { [AMENDED_FROM_COLUMN]: doc.name });
      if (typeof doc.afterAmend === 'function') await doc.afterAmend(copy, options);
    } finally {
      copy.__LIFECYCLE__ = undefined;
    }
  });

  return { name: copy.name, status: LIFECYCLE.DRAFT, navigate: `/desk/${encodeURIComponent(entity)}/update?name=${encodeURIComponent(copy.name)}` };
}

/**
 * Sets `__document_status__` from a status field the entity already kept, for
 * an entity that becomes submittable with data (an app's migration):
 * `draft` values → Draft, `cancelled` → Cancelled, `submitted` → Submitted
 * (every other non-empty value when `submitted` isn't given). Idempotent.
 * → { submitted, cancelled, draft } rows changed
 */
export async function syncLifecycleStatus(entity, { field = 'status', draft = ['Draft'], cancelled = ['Cancelled'], submitted = null } = {}) {
  const out = { submitted: 0, cancelled: 0, draft: 0 };
  if (!loopar.getRef(entity, false) || !(await loopar.db.hasTable(entity))) return out;
  const q = () => loopar.db.qx()(entity);
  const not = (qb, status) => qb.where((w) => w.whereNot('__document_status__', status).orWhereNull('__document_status__'));

  out.cancelled = Number(await not(q().whereIn(field, cancelled), DOC_STATUS.CANCELLED).update({ __document_status__: DOC_STATUS.CANCELLED })) || 0;
  const submittedRows = submitted
    ? q().whereIn(field, submitted)
    : q().whereNotNull(field).whereNot(field, '').whereNotIn(field, [...draft, ...cancelled]);
  out.submitted = Number(await not(submittedRows, DOC_STATUS.SUBMITTED).update({ __document_status__: DOC_STATUS.SUBMITTED })) || 0;
  const draftRows = submitted ? q().whereNotIn(field, [...submitted, ...cancelled]) : q().whereIn(field, draft);
  out.draft = Number(await draftRows.whereIn('__document_status__', [DOC_STATUS.SUBMITTED, DOC_STATUS.CANCELLED]).update({ __document_status__: DOC_STATUS.DRAFT })) || 0;
  return out;
}

const ACTIONS = { Submit: 'submit', Cancel: 'cancel', Amend: 'amend' };

/**
 * Runs a lifecycle action by name ("Submit" | "Cancel" | "Amend") through
 * the document's method, so a model that wraps it (adds checks, a log) is used.
 */
export async function applyLifecycle(doc, action, options = {}) {
  assertSubmittable(doc);
  const method = ACTIONS[action];
  if (!method) loopar.throw({ ...VALIDATION_ERROR, message: `Unknown action "${action}".` });
  if (!lifecycleActions(doc).includes(action)) loopar.throw({ ...VALIDATION_ERROR, message: `${doc.__ENTITY__?.name} runs "${action}" from its own actions.` });
  return await doc[method](options);
}

/** The core actions a model offers (`static lifecycleActions`; all by default). */
function lifecycleActions(doc) {
  const own = doc.constructor?.lifecycleActions;
  return Array.isArray(own) ? own : Object.keys(ACTIONS);
}

/**
 * What the client paints for a submittable record without a workflow: the
 * status badge and its action, in the shape of a workflow (the form's
 * workflow bar renders it). With a workflow, only Amend is added to it.
 */
export async function describeLifecycle(doc, { workflow = null } = {}) {
  const entity = doc.__ENTITY__?.name;
  const status = doc.__IS_NEW__ ? LIFECYCLE.DRAFT : await storedStatus(doc);
  const user = loopar.auth?.user?.();
  const allowed = !entity || PermissionManager.scope(entity, 'lifecycle', user) !== null;

  const transitions = [];
  const offered = lifecycleActions(doc);
  if (!doc.__IS_NEW__ && allowed) {
    if (!workflow && status === LIFECYCLE.DRAFT) {
      transitions.push({ action: 'Submit', style: 'primary', endpoint: 'lifecycle', confirm: `Submit ${entity} ${doc.name}? Once submitted it can't be edited nor deleted, only cancelled.` });
    }
    if (!workflow && status === LIFECYCLE.SUBMITTED) {
      transitions.push({ action: 'Cancel', style: 'destructive', endpoint: 'lifecycle', confirm: `Cancel ${entity} ${doc.name}? It stays as a cancelled record; amend it to make a corrected copy.` });
    }
    if (status === LIFECYCLE.CANCELLED) transitions.push({ action: 'Amend', style: 'primary', endpoint: 'lifecycle' });
  }
  // A model with buttons of its own (Issue, Post…) offers only some of these.
  for (let i = transitions.length - 1; i >= 0; i--) if (!offered.includes(transitions[i].action)) transitions.splice(i, 1);

  return {
    lifecycle: true,
    status,
    amended_from: doc[AMENDED_FROM_COLUMN] || null,
    field: null,
    state: status,
    color: COLORS[status],
    is_final: status === LIFECYCLE.CANCELLED,
    states: Object.values(LIFECYCLE).map((state) => ({ state, color: COLORS[state], is_final: state === LIFECYCLE.CANCELLED, show_on_board: true })),
    transitions,
  };
}
