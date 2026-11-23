'use strict';

import { loopar } from '../loopar.js';
import { compileFormula, formulaRefs, refKey } from '../global/formula.js';

/*
 * References in formulas: `link.field` reads `field` of the record the
 * `connection` field `link` points to (global/formula.js). The server
 * resolves them — on save for a stored formula, on read for a virtual one —
 * with ONE query per connection field, whatever the number of rows.
 */

const CHUNK = 500;
const filled = (v) => v !== null && v !== undefined && v !== "";
const truthy = (v) => [1, "1", true, "true"].includes(v);
const firstLine = (options) => (typeof options === "string" ? options.split(/\r?\n/)[0].trim() : "");

/** The entity a single (not `multiple`) connection field points to, or null. */
function targetOf(meta) {
  if (!meta || meta.element !== CONNECTION || truthy(meta.multiple)) return null;
  return meta.options || null;
}

/**
 * Values the `formulas` of `entity` read from other records, for `rows`.
 *
 * → (row) => { "link.field": value, … }   (null when the record is gone)
 */
export async function formulaRefValues(entity, formulas, rows) {
  const refs = formulaRefs(formulas);
  const links = Object.keys(refs);
  if (!links.length || !Array.isArray(rows) || !rows.length) return () => ({});

  const meta = loopar.getRef(entity)?.__FIELD_META__ || {};
  const found = {};

  await Promise.all(links.map(async (link) => {
    found[link] = new Map();
    const target = targetOf(meta[link]);
    const targetRef = target ? loopar.getRef(target) : null;
    if (!targetRef || targetRef.is_virtual || targetRef.is_single) return;

    const stored = new Set(targetRef.__FIELDS__ || []);
    const fields = refs[link].filter((f) => f === "name" || stored.has(f));
    const names = [...new Set(rows.map((row) => row?.[link]).filter(filled).map(String))];
    if (!fields.length || !names.length) return;

    for (let i = 0; i < names.length; i += CHUNK) {
      let qb = loopar.db.qx()(target).whereIn("name", names.slice(i, i + CHUNK)).select([...new Set(["name", ...fields])]);
      if (stored.has("__deleted_at__")) qb = qb.whereNull("__deleted_at__");
      for (const record of await qb) found[link].set(String(record.name), record);
    }
  }));

  return (row) => {
    const out = {};
    for (const link of links) {
      const record = found[link].get(String(row?.[link] ?? ""));
      for (const field of refs[link]) out[refKey(link, field)] = record?.[field] ?? null;
    }
    return out;
  };
}

/**
 * Why the references of the formulas in `fields` (an entity's flat field
 * list) can't be resolved, as messages. `installing`: the other entities
 * may not be built yet — only what the structure itself says is checked.
 */
export function formulaRefIssues(fields = [], { installing = false } = {}) {
  const byName = Object.fromEntries(fields.filter((f) => f?.data?.name).map((f) => [f.data.name, f]));
  const issues = [];

  for (const field of fields) {
    const formula = String(field?.data?.formula ?? "").trim();
    if (!formula) continue;
    const compiled = compileFormula(formula);
    if (compiled.error) continue;

    for (const { link, field: wanted } of compiled.refs) {
      const where = `Field ${field.data.name}: ${link}.${wanted}`;
      const source = byName[link];
      if (!source || source.element !== CONNECTION) { issues.push(`${where} — ${link} is not a connection field of this entity.`); continue; }
      if (truthy(source.data.multiple)) { issues.push(`${where} — ${link} holds several records: a reference needs a single one.`); continue; }

      const target = firstLine(source.data.options);
      if (!target) { issues.push(`${where} — ${link} does not say which entity it points to.`); continue; }
      if (installing) continue;

      const ref = loopar.getRef(target);
      if (!ref) { issues.push(`${where} — entity ${target} does not exist.`); continue; }
      if (wanted === "name") continue;
      const meta = ref.__FIELD_META__?.[wanted];
      if (!meta) {
        const virtual = wanted in (ref.__VIRTUAL__ || {});
        issues.push(`${where} — ${target} has no stored field ${wanted}${virtual ? " (it is virtual)" : ""}.`);
        continue;
      }
      if (meta.element === PASSWORD) issues.push(`${where} — a password can't be read by a formula.`);
    }
  }
  return issues;
}

