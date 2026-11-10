'use strict';

/**
 * Custom HTML attributes authored on any element (designer "Attributes",
 * stored as `data.attributes` = [{ name, value }] or { name: value }).
 *
 * Only safe names reach the DOM: `data-*`, `aria-*` and a short list of
 * metadata/accessibility attributes. Event handlers, `style`, `class`, `id`
 * and URL-bearing attributes are never accepted (each has its own field or
 * would open script injection).
 */
const ALLOWED = new Set([
  "role", "title", "lang", "dir", "translate", "tabindex",
  "itemscope", "itemtype", "itemprop", "itemid", "itemref",
  "rel", "hreflang", "loading", "decoding", "fetchpriority",
  "inputmode", "enterkeyhint", "autocomplete", "spellcheck",
]);

const NAME = /^[a-z][a-z0-9_.:-]*$/;

export function isAllowedAttribute(name) {
  const n = String(name || "").trim().toLowerCase();
  if (!NAME.test(n) || n.startsWith("on")) return false;
  return n.startsWith("data-") || n.startsWith("aria-") || ALLOWED.has(n);
}

/** Normalized list [{ name, value }] from either stored shape. */
export function attributeList(value) {
  let v = value;
  if (typeof v === "string") {
    try { v = JSON.parse(v); } catch { return []; }
  }
  if (Array.isArray(v)) {
    return v
      .map((row) => ({ name: String(row?.name ?? row?.key ?? "").trim(), value: row?.value ?? "" }))
      .filter((row) => row.name);
  }
  if (v && typeof v === "object") return Object.entries(v).map(([name, value]) => ({ name, value }));
  return [];
}

/** { name: value } with only allowed names; values are always strings. */
export function sanitizeAttributes(value) {
  const out = {};
  for (const { name, value: raw } of attributeList(value)) {
    const n = name.toLowerCase();
    if (!isAllowedAttribute(n)) continue;
    const v = raw === true ? "" : String(raw ?? "");
    if (/^\s*(javascript|vbscript|data):/i.test(v)) continue;
    out[n] = v;
  }
  return out;
}
