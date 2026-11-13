/**
 * Search and social settings of a website page: its `seo` field.
 *
 *   seo: { title, description, og_title, og_description, image, noindex, extra }
 *
 * They are page settings, edited in the designer's "SEO" tab, and render as
 * head tags — never as elements of the canvas. Their translations live with
 * the page's (`translations[lang][SEO_NODE_KEY][field]`), so they are edited
 * in the same "Translations" tab as the rest of the page.
 */

import { SEO_NODE_KEY } from './element-migration.js';
import { entryValue } from './i18n-content.js';

export { SEO_NODE_KEY };

/** Fields with a text a visitor (or a search result) reads: the translatable ones. */
export const SEO_TEXT_FIELDS = ["title", "description", "og_title", "og_description"];

/** Lengths search engines usually show before cutting the text. */
export const SEO_LIMITS = { title: 60, description: 160 };

const isOn = (v) => v === true || v === 1 || v === "1" || v === "true";

/** Parses a `seo` value (JSON text or object) into a plain object. */
export function parsePageSeo(value) {
  if (!value) return {};
  if (typeof value === "object") return Array.isArray(value) ? {} : { ...value };
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** `seo` for storage: trimmed texts, empty fields dropped; "" when nothing is set. */
export function compactPageSeo(seo) {
  const out = {};
  for (const [key, value] of Object.entries(parsePageSeo(seo))) {
    if (key === "noindex") { if (isOn(value)) out.noindex = 1; continue; }
    const text = String(value ?? "").trim();
    if (text) out[key] = text;
  }
  return Object.keys(out).length ? JSON.stringify(out) : "";
}

/** The page's seo with the texts of a language `layer` (translations[lang]) applied. */
export function resolvePageSeo(value, layer = null) {
  const seo = parsePageSeo(value);
  const texts = layer?.[SEO_NODE_KEY];
  if (texts && typeof texts === "object") {
    for (const field of SEO_TEXT_FIELDS) {
      const translated = entryValue(texts[field]);
      if (translated) seo[field] = translated;
    }
  }
  return seo;
}

/** The translatable texts of a page's seo, in the shape of contentTexts(). */
export function seoTexts(value) {
  const seo = parsePageSeo(value);
  return SEO_TEXT_FIELDS
    .filter((field) => String(seo[field] || "").trim())
    .map((prop) => ({ key: SEO_NODE_KEY, element: "seo", prop, value: seo[prop] }));
}

const HEAD_TAGS = new Set(["meta", "link"]);
const SAFE_ATTR = /^[a-zA-Z][a-zA-Z0-9:_-]*$/;

/** Free head tags, one per line: `meta | name=keywords | content=a, b`. */
export function parseExtraTags(text) {
  return String(text || "").split(/\r?\n/).map((line) => {
    const [tag, ...pairs] = line.split("|").map((part) => part.trim());
    if (!HEAD_TAGS.has(String(tag).toLowerCase())) return null;
    const attrs = {};
    for (const pair of pairs) {
      const i = pair.indexOf("=");
      if (i > 0 && SAFE_ATTR.test(pair.slice(0, i).trim())) attrs[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
    }
    // Event handlers and script URLs have no place in a head tag.
    if (Object.keys(attrs).some((k) => /^on/i.test(k)) || /^\s*javascript:/i.test(attrs.href || "")) return null;
    return Object.keys(attrs).length ? { tag: tag.toLowerCase(), attrs } : null;
  }).filter(Boolean);
}

/**
 * Head tags of a page (the <title> is set apart, by the document):
 * `[{ tag, attrs }]`. `origin` makes a site-relative share image absolute,
 * as social networks require.
 */
export function pageSeoTags(value, { origin = "" } = {}) {
  const seo = parsePageSeo(value);
  const tags = [];
  const meta = (attrs) => tags.push({ tag: "meta", attrs });
  const ogTitle = seo.og_title || seo.title;
  const ogDescription = seo.og_description || seo.description;

  if (seo.description) meta({ name: "description", content: seo.description });
  if (ogTitle) meta({ property: "og:title", content: ogTitle });
  if (ogDescription) meta({ property: "og:description", content: ogDescription });
  if (seo.image) {
    const image = /^https?:\/\//i.test(seo.image) ? seo.image : `${origin}${seo.image.startsWith("/") ? "" : "/"}${seo.image}`;
    meta({ property: "og:image", content: image });
    meta({ name: "twitter:card", content: "summary_large_image" });
  }
  if (isOn(seo.noindex)) meta({ name: "robots", content: "noindex, nofollow" });
  tags.push(...parseExtraTags(seo.extra));
  return tags;
}
