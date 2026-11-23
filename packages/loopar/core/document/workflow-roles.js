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
