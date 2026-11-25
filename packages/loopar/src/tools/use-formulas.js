import { useEffect, useMemo, useRef, useState } from "react";
import loopar from "loopar";
import { compileFormula, computeFormulas, fetchIfEmptyFields, formulaFields, formulaRefs, formulasToApply, refKey, sameComputedValue, tableRows } from "@global/formula";

/**
 * Live computed fields (`data.formula`). The server recomputes them on save
 * (and virtual ones on every read); these hooks only mirror the result while
 * the user types. A field is written only when its value actually changes,
 * so the watch → set loop settles.
 *
 * References to linked records (`link.field`) are asked to the server
 * (`{Entity}/formulaRefs`, only the fields the entity's formulas name) when
 * the connection changes. A formula waits for its references: until they
 * arrive it keeps the value the server sent.
 *
 * `fetch_if_empty` fields are editable: the formula fills them only while
 * they are empty, and only when what it reads changed since it last filled
 * them — a user who clears the field on purpose is not overwritten while
 * typing (the server fills it again on save if it is still empty).
 */

const set = (form, name, value) => form.setValue(name, value, { shouldDirty: false, shouldValidate: false });
const filled = (v) => v !== null && v !== undefined && v !== "";

/* One request per (entity, table, link, value), shared by every form on the page. */
const pending = new Map();
function fetchRefs(entity, table, link, value) {
  const key = JSON.stringify([entity, table || null, link, String(value)]);
  if (!pending.has(key)) {
    if (pending.size > 300) pending.clear();
    const request = loopar.call(entity, "formulaRefs", { body: { link, value, ...(table ? { table } : {}) }, freeze: false })
      .then((data) => data?.values || {})
      .catch(() => { pending.delete(key); return null; });
    pending.set(key, request);
  }
  return pending.get(key);
}

/** The links each formula reads: `{ field: [link, …] }`. */
function linksByFormula(formulas) {
  return Object.fromEntries(Object.entries(formulas).map(([name, formula]) => {
    const compiled = compileFormula(formula);
    return [name, compiled.error ? [] : [...new Set(compiled.refs.map((r) => r.link))]];
  }));
}

/**
 * Values of the links in `scopes` (one per row, or the form alone):
 * `{ "link|value": { "link.field": v } }`, filled as the answers arrive.
 */
function useLinkedValues(entity, table, links, scopes) {
  const [known, setKnown] = useState({});
  const wanted = useMemo(() => {
    const out = new Map();
    for (const scope of scopes) {
      for (const link of links) {
        const value = scope?.[link];
        if (filled(value)) out.set(`${link}|${value}`, [link, value]);
      }
    }
    return out;
  }, [links, scopes]);

  useEffect(() => {
    if (!entity || !wanted.size) return;
    let alive = true;
    for (const [key, [link, value]] of wanted) {
      if (key in known) continue;
      fetchRefs(entity, table, link, value).then((values) => {
        if (alive && values) setKnown((k) => (key in k ? k : { ...k, [key]: values }));
      });
    }
    return () => { alive = false; };
  }, [entity, table, wanted, known]);

  return known;
}

/**
 * The formulas ready to compute over `scope` (their references known) and the
 * scope with those references in it.
 */
function readyScope(formulas, needs, refs, known, scope) {
  const extra = {};
  const ready = {};
  for (const [name, formula] of Object.entries(formulas)) {
    let ok = true;
    for (const link of needs[name] || []) {
      const value = scope?.[link];
      if (!filled(value)) {
        for (const field of refs[link] || []) extra[refKey(link, field)] = null;
      } else {
        const values = known[`${link}|${value}`];
        if (!values) { ok = false; break; }
        Object.assign(extra, values);
      }
    }
    if (ok) ready[name] = formula;
  }
  return { ready, scope: { ...scope, ...extra } };
}

/** What a formula read (its fields and references) — to tell when its inputs changed. */
function inputsOf(formula, scope) {
  const compiled = compileFormula(formula);
  if (compiled.error) return "";
  return JSON.stringify([
    compiled.fields.map((f) => scope?.[f] ?? null),
    compiled.refs.map((r) => scope?.[refKey(r.link, r.field)] ?? null),
  ]);
}

/**
 * Writes the computed values of one form (or row): `prefix` is "" or
 * "rows.<i>.". A `fetch_if_empty` field (here always empty: filled ones are
 * left out by formulasToApply) is written once per change of its inputs.
 */
function writeComputed(form, computed, current, { formulas, ifEmpty, scope, filledFor, prefix = "", track = prefix }) {
  for (const [name, value] of Object.entries(computed)) {
    if (ifEmpty.has(name)) {
      const key = `${track}${name}`;
      const inputs = inputsOf(formulas[name], scope);
      if (filledFor.current[key] === inputs) continue;
      filledFor.current[key] = inputs;
    }
    if (!sameComputedValue(current?.[name], value)) set(form, `${prefix}${name}`, value);
  }
}

/**
 * Formula fields of a flat form, computed over its live `values`. `entity`:
 * the form's entity — for one row of a child table edited on its own (the
 * row form), the parent entity and `table`, its child table field.
 */
export function useFormulas(form, structure, values, { entity = null, table = null } = {}) {
  const formulas = useMemo(() => formulaFields(structure), [structure]);
  const refs = useMemo(() => formulaRefs(formulas), [formulas]);
  const needs = useMemo(() => linksByFormula(formulas), [formulas]);
  const links = useMemo(() => Object.keys(refs), [refs]);
  const ifEmptyList = useMemo(() => fetchIfEmptyFields(structure), [structure]);
  const ifEmpty = useMemo(() => new Set(ifEmptyList), [ifEmptyList]);
  const filledFor = useRef({});
  const scopes = useMemo(() => [values || {}], [values]);
  const known = useLinkedValues(entity, table, links, scopes);

  useEffect(() => {
    if (!form || !values || !Object.keys(formulas).length) return;
    const applying = formulasToApply(formulas, ifEmptyList, values);
    const { ready, scope } = readyScope(applying, needs, refs, known, values);
    writeComputed(form, computeFormulas(ready, scope), values, { formulas, ifEmpty, scope, filledFor });
  }, [form, formulas, refs, needs, known, values, ifEmpty, ifEmptyList]);
}

/**
 * Formula fields of a child table, computed per row (`<path>.<index>.<field>`).
 * `entity` / `table`: the parent entity and its child table field, to resolve
 * references of the rows.
 */
export function useRowFormulas(form, structure, rows, path = "rows", { entity = null, table = null } = {}) {
  const formulas = useMemo(() => formulaFields(structure), [structure]);
  const refs = useMemo(() => formulaRefs(formulas), [formulas]);
  const needs = useMemo(() => linksByFormula(formulas), [formulas]);
  const links = useMemo(() => Object.keys(refs), [refs]);
  const ifEmptyList = useMemo(() => fetchIfEmptyFields(structure), [structure]);
  const ifEmpty = useMemo(() => new Set(ifEmptyList), [ifEmptyList]);
  const filledFor = useRef({});
  const scopes = useMemo(() => tableRows(rows), [rows]);
  const known = useLinkedValues(table ? entity : null, table, links, scopes);

  useEffect(() => {
    if (!form || !Object.keys(formulas).length) return;
    scopes.forEach((row, index) => {
      if (!row) return;
      const applying = formulasToApply(formulas, ifEmptyList, row);
      const { ready, scope } = readyScope(applying, needs, refs, known, row);
      // A row is tracked by its id when it has one: rows can move.
      const prefix = `${path}.${index}.`;
      const track = row.id ? `${path}#${row.id}.` : prefix;
      writeComputed(form, computeFormulas(ready, scope), row, { formulas, ifEmpty, scope, filledFor, prefix, track });
    });
  }, [form, formulas, refs, needs, known, scopes, path, ifEmpty, ifEmptyList]);
}
