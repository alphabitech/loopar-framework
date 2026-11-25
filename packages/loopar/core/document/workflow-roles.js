'use strict';

import { loopar } from '../loopar.js';
import { invalidateWorkflows } from './workflow.js';

const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

/**
 * The transition rows of a workflow in this workspace. Read and written
 * directly: saving the Workflow document rewrites the workflow's source
 * (its app's installer), and these are changes of this workspace only.
 */
async function transitionsOf(workflow) {
  const q = () => loopar.db.qx();
  if (!(await q().schema.hasTable('Workflow')) || !(await q().schema.hasTable('Workflow Transition'))) return null;
  // Names matched in JS: MySQL compares case-insensitively.
  const [wf] = (await q()('Workflow').select('id', 'name')).filter((w) => w.name === workflow);
  if (!wf) return null;
  return await q()('Workflow Transition').where({ parent_document: 'Workflow', parent_id: wf.id }).select('id', 'action', 'allowed_roles');
}

async function setRoles(workflow, next) {
  const rows = await transitionsOf(workflow);
  if (!rows) return false;
  let changed = false;
  for (const row of rows) {
    const roles = next(row.action, list(row.allowed_roles));
    if (!roles) continue;
    await loopar.db.qx()('Workflow Transition').where({ id: row.id }).update({ allowed_roles: roles.join(', ') });
    changed = true;
  }
  if (changed) invalidateWorkflows();
  return changed;
}

/**
 * Lets `roles` run transitions of a workflow that are narrowed to roles:
 * `grantWorkflowRoles('Purchase Order', { Approve: ['Warehouse Manager'] })`.
 *
 * For an app built on another: its own roles act on that app's documents,
 * whose workflows can't name them. Roles are added, never removed; a
 * transition open to everyone (no roles) stays open. Idempotent.
 */
export async function grantWorkflowRoles(workflow, grants = {}) {
  return await setRoles(workflow, (action, current) => {
    const add = grants[action];
    if (!add?.length || !current.length) return null;
    const next = [...new Set([...current, ...add])];
    return next.length === current.length ? null : next;
  });
}

/**
 * Narrows transitions that an earlier version shipped open to everyone:
 * `restrictWorkflowRoles('Purchase Order', { Approve: ['Purchase Manager'] })` sets the
 * roles only where there are none. Idempotent.
 */
export async function restrictWorkflowRoles(workflow, roles = {}) {
  return await setRoles(workflow, (action, current) => (roles[action]?.length && !current.length ? roles[action] : null));
}

/**
 * Changes this workspace's copy of a workflow an app shipped earlier (its
 * installer does not overwrite records that exist): states and transitions
 * matched by name are updated with the given columns; `add` ones are created
 * when missing; `remove` ones are deleted. Idempotent.
 *
 *   await shapeWorkflow('Quote', {
 *     states: { Approved: { doc_status: 'Submitted' }, Cancelled: { add: true, color: 'red', is_final: 1 } },
 *     transitions: { Revise: { from_state: 'Rejected, Expired' }, Cancel: { add: true, from_state: 'Approved', to_state: 'Cancelled' } },
 *     remove: { transitions: ['Reopen'] },
 *   });
 */
export async function shapeWorkflow(workflow, { states = {}, transitions = {}, remove = {} } = {}) {
  const q = () => loopar.db.qx();
  if (!(await q().schema.hasTable('Workflow'))) return false;
  const [wf] = (await q()('Workflow').select('id', 'name')).filter((w) => w.name === workflow);
  if (!wf) return false;
  let changed = false;

  const apply = async (table, keyField, specs, removed = []) => {
    if (!(await q().schema.hasTable(table))) return;
    const rows = await q()(table).where({ parent_document: 'Workflow', parent_id: wf.id }).select('*');
    const columns = new Set(Object.keys(rows[0] || {}));
    for (const row of rows) {
      if (removed.includes(row[keyField])) {
        await q()(table).where({ id: row.id }).delete();
        changed = true;
      }
    }
    for (const [key, { add, ...values }] of Object.entries(specs)) {
      const row = rows.find((r) => r[keyField] === key);
      if (row) {
        const patch = Object.fromEntries(Object.entries(values).filter(([k, v]) => (!columns.size || columns.has(k)) && String(row[k] ?? '') !== String(v ?? '')));
        if (Object.keys(patch).length) { await q()(table).where({ id: row.id }).update(patch); changed = true; }
      } else if (add) {
        const position = rows.reduce((n, r) => Math.max(n, Number(r.__position__ ?? 0)), -1) + 1;
        await loopar.db.insertRow(table, {
          name: loopar.utils.randomString(15), parent_document: 'Workflow', parent_id: wf.id, __position__: position,
          [keyField]: key, ...values,
        });
        changed = true;
      }
    }
  };

  await apply('Workflow State', 'state', states, remove.states || []);
  await apply('Workflow Transition', 'action', transitions, remove.transitions || []);
  if (changed) invalidateWorkflows();
  return changed;
}
