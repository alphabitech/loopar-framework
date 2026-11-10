'use strict';

// Pure: the refs are read through `getRef(name)` (loopar.getRef server side,
// a stub in tests). See core/document/parent-filter.js for the bound version.
const key = (s) => String(s || "").trim().toLowerCase().replace(/[\s_-]+/g, "");

/**
 * The field of `target` a cascading connection compares with its parent
 * value, when the field doesn't name it (`parent_filter` empty):
 *  - the parent is a connection to X → the one field of `target` that is a
 *    connection to X (city.state → State, whatever it is called);
 *  - otherwise, or with no single match, the target field named like the
 *    parent.
 * `source` is the entity the parent field belongs to; a parent found in one
 * of its child tables counts too (cascades inside form_table rows).
 * Returns null when nothing fits: the caller then doesn't filter.
 */
export function inferParentFilter({ target, source, parent, parentFilter = null }, getRef) {
  const targetRef = getRef(target);
  const targetMeta = targetRef?.__FIELD_META__ || {};
  if (parentFilter) return parentFilter;
  if (!parent) return null;

  const parentMeta = findFieldMeta(source, parent, getRef);
  if (parentMeta?.element === "connection" && parentMeta.options) {
    const linked = key(parentMeta.options);
    const matches = Object.entries(targetMeta).filter(([, m]) =>
      m.element === "connection" && m.options && key(m.options) === linked);
    if (matches.length === 1) return matches[0][0];
  }

  return (targetMeta[parent] || targetRef?.is_virtual) ? parent : null;
}

/** Field `name` of `entity`, or of one of its child tables. */
export function findFieldMeta(entity, name, getRef) {
  const ref = entity ? getRef(entity) : null;
  if (!ref) return null;
  const meta = ref.__FIELD_META__ || {};
  if (meta[name]) return meta[name];
  for (const m of Object.values(meta)) {
    if (m.element !== "form_table" || !m.options) continue;
    const child = getRef(m.options)?.__FIELD_META__?.[name];
    if (child) return child;
  }
  return null;
}

/**
 * Static filters of a connection (`filters` metafield): one `field = value`
 * per line, or a JSON object. Always an object; unknown shapes give {}.
 */
export function parseFilters(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return Array.isArray(raw) ? {} : raw;
  const text = String(raw).trim();
  if (text.startsWith("{")) {
    try { const o = JSON.parse(text); return o && typeof o === "object" && !Array.isArray(o) ? o : {}; } catch { return {}; }
  }
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([\w.-]+)\s*[=:]\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
