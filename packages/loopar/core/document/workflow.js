'use strict';

import { loopar } from '../loopar.js';
import { Op } from 'db-env';

/**
 * Workflows: an entity's lifecycle as data (core entities Workflow,
 * Workflow State, Workflow Transition). The state lives in one select field
 * of the entity (`state_field`) and only changes through a transition:
 *
 *   - new records start in the initial state, whatever the client sends;
 *   - a save outside a transition keeps the stored state;
 *   - `applyTransition` checks the user, the required fields and the model's
 *     `beforeTransition`, runs the transition's method (only if the model
 *     lists it in `static workflowMethods`) and moves the state.
 */

const isTrue = (v) => [1, '1', true, 'true'].includes(v);
const list = (v) => String(v || '').split(',').map(s => s.trim()).filter(Boolean);

// tenant → Map(entity → definition | null)
const cache = new Map();

function tenantCache() {
  const key = loopar.tenantId || '__default__';
  if (!cache.has(key)) cache.set(key, new Map());
  return cache.get(key);
}

/** Drops the cached definitions of the current tenant (Workflow saves/deletes call it). */
export function invalidateWorkflows() {
  tenantCache().clear();
}

async function childRows(entity, parentId) {
  return await loopar.db.query(entity)
    .where({ parent_document: 'Workflow', parent_id: parentId })
    .orderBy('id', 'asc')
    .select('*');
}

async function load(entityName) {
  const row = await loopar.db.query('Workflow')
    .where({ document: entityName, active: 1 })
    .whereNull('__deleted_at__')
    .first();
  if (!row) return null;

  const states = (await childRows('Workflow State', row.id)).map(s => ({
    state: s.state,
    color: s.color || 'gray',
    is_initial: isTrue(s.is_initial),
    is_final: isTrue(s.is_final),
    public_label: s.public_label || null,
    show_on_board: s.show_on_board == null ? true : isTrue(s.show_on_board),
  }));

  const transitions = (await childRows('Workflow Transition', row.id)).map(t => ({
    action: t.action,
    from: list(t.from_state),
    to: t.to_state,
    roles: list(t.allowed_roles),
    allow_submitter: isTrue(t.allow_submitter),
    system_only: isTrue(t.system_only),
    required_fields: list(t.required_fields),
    method: t.method || null,
    confirm: t.confirm || null,
    notify: t.notify || 'None',
    style: t.style || 'default',
  }));

  const initial = states.find(s => s.is_initial) || states[0];
  return { name: row.name, document: entityName, field: row.state_field, states, transitions, initial: initial?.state };
}

/**
 * Records without a state (saved before the workflow existed) start in the
 * initial state. Run when a workflow is saved, so lists, filters and the
 * board see them too.
 */
export async function backfillInitialState(entityName, field, initial) {
  if (!entityName || !field || !initial) return 0;
  return await loopar.db.query(entityName)
    .where(q => q.whereNull(field).orWhere(field, ''))
    .update({ [field]: initial });
}

/** Active workflow of `entityName`, or null. Cached per tenant. */
export async function workflowFor(entityName) {
  if (!entityName) return null;
  // Installing/updating: the Workflow tables may not exist (or lack columns)
  // yet, and installers save plain data. No workflow rules, nothing cached.
  if (loopar.installing || !loopar.getRef('Workflow')) return null;

  const c = tenantCache();
  if (!c.has(entityName)) {
    try {
      c.set(entityName, await load(entityName));
    } catch (error) {
      // Table not migrated yet: behave as "no workflow" without caching it.
      console.warn(`[workflow] not available for ${entityName}:`, error.message);
      return null;
    }
  }
  return c.get(entityName);
}

async function rolesOf(user) {
  if (!user) return [];
  const rows = await loopar.db.getAll('User Role', ['role'], { user });
  return rows.map(r => r.role);
}

/** The document's state; records saved before the workflow existed count as initial. */
const stateOf = (doc, wf) => doc[wf.field] || wf.initial;

/**
 * Transitions `user` may run from the document's current state. System-only
 * transitions are never offered to users; `system: true` (model code) gets
 * them, and every other transition, without the role check.
 */
export async function availableTransitions(doc, wf, user = loopar.auth?.user?.(), { system = false } = {}) {
  const current = stateOf(doc, wf);
  const state = wf.states.find(s => s.state === current);
  if (state?.is_final && !wf.transitions.some(t => t.from.includes(current))) return [];

  const admin = user === 'Administrator';
  const roles = admin || system ? [] : await rolesOf(user);

  return wf.transitions.filter(t => {
    const fromOk = t.from.includes(current) || (t.from.includes('*') && !state?.is_final);
    if (!fromOk || t.to === current) return false;
    if (system) return true;
    if (t.system_only) return false;
    return admin || !t.roles.length || t.roles.some(r => roles.includes(r));
  });
}

/** Every transition `user` may run, from any state (the Kanban board validates drops with it). */
export async function userTransitions(wf, user = loopar.auth?.user?.()) {
  const admin = user === 'Administrator';
  const roles = admin ? [] : await rolesOf(user);
  return wf.transitions.filter(t => !t.system_only && (admin || !t.roles.length || t.roles.some(r => roles.includes(r))));
}

const clientTransition = (t) => ({
  action: t.action, from: t.from, to: t.to, required_fields: t.required_fields, confirm: t.confirm, style: t.style,
});

/** What the client needs to paint the state badge and the transition buttons. */
export async function describeWorkflow(doc, wf) {
  const current = doc.__IS_NEW__ ? wf.initial : stateOf(doc, wf);
  const state = wf.states.find(s => s.state === current) || { state: current, color: 'gray' };
  return {
    field: wf.field,
    state: state.state,
    color: state.color,
    is_final: !!state.is_final,
    states: wf.states.map(({ state, color, is_final, show_on_board }) => ({ state, color, is_final, show_on_board })),
    transitions: doc.__IS_NEW__ ? [] : (await availableTransitions(doc, wf)).map(clientTransition),
    // Lists (the Kanban board) get every transition the user may run.
    ...(doc.__IS_NEW__ ? { board: (await userTransitions(wf)).map(clientTransition) } : {}),
  };
}

/**
 * Called by CoreDocument.save before beforeSave: pins the state field unless
 * the save is part of a transition (`doc.__TRANSITION__`).
 */
export async function guardWorkflowState(doc) {
  if (doc.__ENTITY__?.is_single) return;
  const wf = await workflowFor(doc.__ENTITY__?.name);
  if (!wf || !wf.field || doc.__TRANSITION__) return;

  if (doc.__IS_NEW__) {
    doc[wf.field] = wf.initial;
    return;
  }

  const stored = await loopar.db.getValue(doc.__ENTITY__.name, wf.field, doc.__DOCUMENT_NAME__, { ifNotFound: null });
  doc[wf.field] = stored ?? wf.initial;
}

const isEmpty = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

async function notify(doc, wf, t, from) {
  if (t.notify === 'None') return;
  try {
    let to = null;
    if (t.notify === 'Submitter') {
      const field = Object.values(doc.fields).find(f => f.format === 'email' || f.name === 'email');
      to = field?.value || null;
    } else if (t.notify === 'Roles' && t.roles.length) {
      const users = await loopar.db.getAll('User Role', ['user'], { role: { [Op.in]: t.roles } });
      const emails = await Promise.all(users.map(u => loopar.db.getValue('User', 'email', u.user, { ifNotFound: null })));
      to = [...new Set(emails.filter(Boolean))].join(',') || null;
    }
    if (!to) return;

    const entity = doc.__ENTITY__.name;
    await loopar.mail.send({
      to,
      subject: `${entity} ${doc.name}: ${t.to}`,
      html: `<p><strong>${entity} ${doc.name}</strong> moved from <em>${from}</em> to <strong>${t.to}</strong> (${t.action}).</p>`,
    });
  } catch (error) {
    console.error(`[workflow] notify failed for ${doc.__ENTITY__?.name} ${doc.name}:`, error.message);
  }
}

/**
 * Runs transition `action` on `doc` for the current user. `values` may only
 * fill the transition's required fields. Returns `{ name, state, navigate }`.
 */
/**
 * `options.system`: run by model code on behalf of nobody in particular (a
 * signer on a public link, a scheduled job) — skips the role check and may
 * run system-only transitions. Never set it from a user request.
 */
export async function applyTransition(doc, action, values = {}, { system = false } = {}) {
  const wf = await workflowFor(doc.__ENTITY__.name);
  if (!wf) loopar.throw(`${doc.__ENTITY__.name} has no active workflow.`);

  const from = stateOf(doc, wf);
  const t = (await availableTransitions(doc, wf, undefined, { system })).find(x => x.action === action);
  if (!t) loopar.throw(`"${action}" is not available for ${doc.__ENTITY__.name} ${doc.name} in state ${from}.`);

  for (const name of t.required_fields) {
    if (!isEmpty(values[name])) doc[name] = values[name];
    if (isEmpty(doc[name])) {
      const field = doc.fields?.[name];
      loopar.throw(`${field?.label || name} is required to ${t.action.toLowerCase()}.`);
    }
  }

  doc.__TRANSITION__ = t;
  try {
    if (typeof doc.beforeTransition === 'function') await doc.beforeTransition(t, from);

    let result = null;
    if (t.method) {
      const allowed = doc.constructor.workflowMethods || [];
      if (!allowed.includes(t.method) || typeof doc[t.method] !== 'function') {
        loopar.throw(`${doc.__ENTITY__.name} does not allow the workflow method "${t.method}".`);
      }
      result = await doc[t.method](t);
    }

    doc[wf.field] = t.to;
    await doc.save();

    await notify(doc, wf, t, from);
    return { name: doc.name, state: t.to, navigate: result?.navigate || null };
  } finally {
    doc.__TRANSITION__ = null;
  }
}
