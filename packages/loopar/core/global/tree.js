'use strict';

import { isComputedField } from "./formula.js";

/**
 * Tree of an entity — shared by the server (which reads the records) and the
 * client (which draws them). An entity is a tree by convention; there is
 * nothing to configure: a `connection` to the entity itself named `parent`
 * or `parent_<something>` (`parent_account`, `parent_item_group`) says which
 * record each one hangs from. Other links to the same entity (`reversal_of`,
 * `return_against`) are references, not a hierarchy.
 *
 * Hidden fields and the rows of child tables don't count.
 */

const truthy = (value) => [1, "1", true, "true"].includes(value);
const PARENT_NAME = /^parent(_[a-z0-9_]+)?$/;

function safeParse(text) {
  try { return JSON.parse(text); } catch { return []; }
}

function parentElement(structure, entity) {
  for (const el of structure || []) {
    if (el?.element === "form_table") continue;
    const data = el?.data || {};
    if (el?.element === "connection" && PARENT_NAME.test(String(data.name || ""))
      && String(data.options || "").trim() === entity && !truthy(data.hidden) && !truthy(data.multiple)) return el;
    const nested = el?.elements ? parentElement(el.elements, entity) : null;
    if (nested) return nested;
  }
  return null;
}

/**
 * `{ parent, editable }` for the structure of `entity`, or null when it is
 * not a tree. `parent` names the field with the record above; `editable` is
 * false when that field is read-only (records can't be moved).
 */
export function treeFields(structure, entity) {
  const parsed = typeof structure === "string" ? safeParse(structure) : structure;
  const el = entity ? parentElement(Array.isArray(parsed) ? parsed : [], String(entity)) : null;
  if (!el) return null;
  return { parent: el.data.name, editable: !truthy(el.data.readonly) && !truthy(el.data.read_only) && !isComputedField(el.data) };
}

const filled = (value) => value !== null && value !== undefined && value !== "";

/**
 * Rows arranged as a tree, in the order they come.
 *
 * → { roots: [name], children: { [name]: [name] }, byName: { [name]: row } }
 *
 * A record whose parent is not among the rows (out of the user's scope, or
 * past the limit) is a root; so is every record of a loop of parents, so no
 * record is ever left out.
 */
export function buildTree(rows, parent) {
  const byName = {};
  for (const row of rows || []) byName[row.name] = row;

  const children = {};
  const roots = [];
  for (const row of rows || []) {
    const above = row[parent];
    if (filled(above) && byName[above] && above !== row.name) (children[above] ||= []).push(row.name);
    else roots.push(row.name);
  }

  // Loops (a → b → a) hang from nothing: their records would never be reached.
  const reached = new Set();
  const walk = (name) => {
    if (reached.has(name)) return;
    reached.add(name);
    (children[name] || []).forEach(walk);
  };
  roots.forEach(walk);
  for (const row of rows || []) {
    if (reached.has(row.name)) continue;
    const above = row[parent];
    children[above] = (children[above] || []).filter((name) => name !== row.name);
    roots.push(row.name);
    walk(row.name);
  }

  return { roots, children, byName };
}

/** Names of every record below `name`. */
export function descendantsOf(children, name) {
  const out = new Set();
  const walk = (current) => (children[current] || []).forEach((child) => {
    if (out.has(child)) return;
    out.add(child);
    walk(child);
  });
  walk(name);
  return out;
}

/** Whether `name` may hang from `target`: not from itself nor from a record below it. */
export const canMoveUnder = (children, name, target) =>
  name !== target && !descendantsOf(children, name).has(target);

/** `matches` plus every record above one of them: what a filtered tree shows. */
export function withAncestors(byName, parent, matches) {
  const out = new Set();
  for (const name of matches || []) {
    let current = name;
    while (filled(current) && byName[current] && !out.has(current)) {
      out.add(current);
      current = byName[current][parent];
    }
  }
  return out;
}

/**
 * The tree as the rows to draw, top to bottom: only the records in `visible`
 * (all, when null) and, below a record, only when it is in `expanded`
 * (everything open, when null).
 *
 * → [{ name, depth, hasChildren, open }]
 */
export function flattenTree({ roots, children }, { expanded = null, visible = null } = {}) {
  const out = [];
  const shown = (name) => !visible || visible.has(name);
  const walk = (name, depth) => {
    const below = (children[name] || []).filter(shown);
    const open = below.length > 0 && (!expanded || expanded.has(name));
    out.push({ name, depth, hasChildren: below.length > 0, open });
    if (open) below.forEach((child) => walk(child, depth + 1));
  };
  roots.filter(shown).forEach((name) => walk(name, 0));
  return out;
}

/**
 * Branch totals: `{ [name]: { [field]: sum } }` — each record's own value
 * plus those of every record below it (in `visible`, when given).
 */
export function branchTotals({ roots, children, byName }, fields, visible = null) {
  const totals = {};
  if (!fields?.length) return totals;
  const shown = (name) => !visible || visible.has(name);
  const number = (value) => { const n = Number(value); return Number.isFinite(n) ? n : 0; };
  const walk = (name) => {
    const sum = Object.fromEntries(fields.map((field) => [field, number(byName[name]?.[field])]));
    for (const child of (children[name] || []).filter(shown)) {
      const below = walk(child);
      for (const field of fields) sum[field] += below[field];
    }
    totals[name] = sum;
    return sum;
  };
  roots.filter(shown).forEach(walk);
  return totals;
}
