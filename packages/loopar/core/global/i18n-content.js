/**
 * Language layers of website content (see docs: "Una página, capa por idioma").
 *
 * A page keeps ONE layout (`doc_structure`, written in the site's default
 * language) and, per extra language, only its texts, keyed by the node's
 * immutable key and the prop:
 *
 *   translations: { es: { "<nodeKey>": { text: { value: "Hola", source: "1f2e3d4c" } } } }
 *
 * Translatable record fields use the same entries, keyed by field name:
 *
 *   translations: { es: { title: { value: "…", source: "…" } } }
 *
 * `source` is a fingerprint of the base text the translation was made
 * from: when the base text changes, the translation still shows but the
 * editors flag it as outdated. Untranslated texts fall back to the base.
 */
import { normalizeLanguage } from "./i18n.js";

/**
 * Visible text props of an element come from its definition
 * (element-definition.js): `content` declares them ({ title: "line",
 * text: "text"… }) and an app element may list `translatable` instead.
 */
const DEFAULT_PROPS = ["text"];

/** Short, stable fingerprint of a text (FNV-1a 32-bit, hex): same result in Node and the browser. */
export function sourceHash(text) {
  let h = 0x811c9dc5;
  const s = String(text ?? "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** The translated text of an entry ({ value, source }; a bare string reads as its value). */
export function entryValue(entry) {
  if (typeof entry === "string") return entry;
  return entry && typeof entry === "object" && typeof entry.value === "string" ? entry.value : "";
}

/**
 * An entry for `value` translated from `base`. `machine`: it came from the
 * AI and nobody reviewed it yet (shown, but flagged in the editors).
 */
export function makeEntry(value, base, { machine = false } = {}) {
  return { value, source: sourceHash(base), ...(machine ? { machine: true } : {}) };
}

/** True for an AI translation nobody reviewed yet. */
export function isMachine(entry) {
  return !!(entry && typeof entry === "object" && entry.machine);
}

/**
 * "missing" | "translated" | "outdated" — outdated: the base text changed
 * after the translation was made (its fingerprint no longer matches).
 */
export function entryState(entry, base) {
  if (!entryValue(entry)) return "missing";
  const source = entry && typeof entry === "object" ? entry.source : null;
  return source && source !== sourceHash(base) ? "outdated" : "translated";
}

/** Inputs (form and system groups) translate what the user reads around them. */
const INPUT_PROPS = ["label", "description", "placeholder"];
const INPUT_GROUPS = new Set(["form", "system"]);

export function contentTextProps(element, definition = null) {
  if (Array.isArray(definition?.translatable)) return definition.translatable;
  if (definition?.content) return Object.keys(definition.content);
  return INPUT_GROUPS.has(definition?.group) ? INPUT_PROPS : DEFAULT_PROPS;
}

/** Stable key of a doc_structure node (same rule as getNodeKey, without the random fallback). */
export function contentNodeKey(node) {
  return node?.node ?? node?.key ?? node?.data?.key ?? null;
}

/** Parses a `translations` value (JSON text or object) into an object. */
export function parseTranslations(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** The layer of one language: { nodeKey|field: … } or null. */
export function translationLayer(translations, language) {
  const all = parseTranslations(translations);
  const code = normalizeLanguage(language);
  const layer = code && all[code];
  return layer && typeof layer === "object" && Object.keys(layer).length ? layer : null;
}

/**
 * Copy of `nodes` with the texts of `layer` applied. Only props listed for
 * each element are replaced, and only with non-empty strings.
 */
export function applyContentLayer(nodes, layer, definitionOf = () => null) {
  if (!layer || !Array.isArray(nodes)) return nodes;
  return nodes.map((node) => {
    if (!node || typeof node !== "object") return node;
    const key = contentNodeKey(node);
    const texts = key != null ? layer[key] : null;
    let data = node.data;
    if (texts && data) {
      const allowed = contentTextProps(node.element, definitionOf(node.element));
      for (const prop of allowed) {
        const v = entryValue(texts[prop]);
        if (v !== "") {
          if (data === node.data) data = { ...node.data };
          data[prop] = v;
        }
      }
    }
    const elements = Array.isArray(node.elements) ? applyContentLayer(node.elements, layer, definitionOf) : node.elements;
    return data === node.data && elements === node.elements ? node : { ...node, data, elements };
  });
}

/**
 * The translatable texts of a page, in document order:
 * [{ key, element, prop, value }]. Feeds the designer's translation view
 * and lets a tool count what is still untranslated.
 */
export function contentTexts(nodes, definitionOf = () => null, out = []) {
  for (const node of Array.isArray(nodes) ? nodes : []) {
    const key = contentNodeKey(node);
    if (key != null && node?.data) {
      for (const prop of contentTextProps(node.element, definitionOf(node.element))) {
        const value = node.data[prop];
        if (typeof value === "string" && value.trim() !== "") out.push({ key, element: node.element, prop, value });
      }
    }
    contentTexts(node?.elements, definitionOf, out);
  }
  return out;
}

/** Record fields: `row` with the translated values of `fields` for `language`. */
export function applyRecordLayer(row, fields, language) {
  if (!row || typeof row !== "object" || !row.translations) return row;
  const layer = translationLayer(row.translations, language);
  if (!layer) return row;
  let out = row;
  for (const field of fields) {
    const v = entryValue(layer[field]);
    if (v !== "") {
      if (out === row) out = { ...row };
      out[field] = v;
    }
  }
  return out;
}

/**
 * Normalizes `translations` for storage: entries as { value, source },
 * empty translations removed (they fall back to the base text), empty
 * nodes and languages dropped.
 *   Page layers: { lang: { nodeKey: { prop: entry } } }
 *   Record layers: { lang: { field: entry } }
 */
export function compactTranslations(translations) {
  const all = parseTranslations(translations);
  // A page node can have a prop named `value` (markdown): an entry is one whose `value` is a string.
  const isEntry = (v) => typeof v === "string" || (v && typeof v === "object" && typeof v.value === "string");
  const clean = (v) => (typeof v === "string" ? { value: v } : { value: v.value, ...(v.source ? { source: v.source } : {}), ...(v.machine ? { machine: true } : {}) });
  const out = {};
  for (const [lang, layer] of Object.entries(all)) {
    const code = normalizeLanguage(lang);
    if (!code || !layer || typeof layer !== "object") continue;
    const next = {};
    for (const [k, v] of Object.entries(layer)) {
      if (isEntry(v)) {
        if (entryValue(v)) next[k] = clean(v);
      } else if (v && typeof v === "object") {
        const props = {};
        for (const [prop, e] of Object.entries(v)) if (isEntry(e) && entryValue(e)) props[prop] = clean(e);
        if (Object.keys(props).length) next[k] = props;
      }
    }
    if (Object.keys(next).length) out[code] = next;
  }
  return out;
}
