/**
 * Translation runtime shared by the server, the SSR render and the browser.
 *
 * Frappe-style: the English source text IS the key. `__("Save")` returns the
 * translation of "Save" in the active language, or "Save" itself when there
 * is none. Placeholders: `{0}`, `{1}` (array args) or `{name}` (object args).
 *
 *   __("Save")                          → "Guardar"
 *   __("{0} is required", [label])      → "Nombre es obligatorio"
 *   __("Hello {name}", { name })        → "Hola Ana"
 *
 * Where the active language and its dictionary come from depends on where
 * the code runs, so this module only asks a *provider*:
 *   - Server (requests, SSR): core/server/i18n.js installs a provider that
 *     reads the request language from the request context. The provider
 *     lives on globalThis because Vite's SSR module graph loads its own copy
 *     of this file — a module-level variable would not be shared.
 *   - Browser: the page carries `window.__LOOPAR_I18N__ = { language,
 *     messages }` (written by WorkspaceController.render before hydration).
 */

const PROVIDER_KEY = "__LOOPAR_I18N_PROVIDER__";
const CLIENT_KEY = "__LOOPAR_I18N__";

export const DEFAULT_LANGUAGE = "en";

/**
 * Native names of the languages Loopar knows how to label. Any BCP-47 code
 * works; this table only gives the selectors a readable name.
 */
export const LANGUAGE_NAMES = Object.freeze({
  en: "English",
  es: "Español",
  pt: "Português",
  "pt-br": "Português (Brasil)",
  fr: "Français",
  de: "Deutsch",
  it: "Italiano",
  nl: "Nederlands",
  ca: "Català",
  ja: "日本語",
  zh: "中文",
  ko: "한국어",
});

const LANGUAGE_RE = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/;

/** "es_MX", " ES-mx " → "es-mx"; anything that isn't a language code → null. */
export function normalizeLanguage(code) {
  if (typeof code !== "string") return null;
  const c = code.trim().toLowerCase().replace(/_/g, "-");
  return LANGUAGE_RE.test(c) ? c : null;
}

/** "es-mx" → "es"; "es" → null. The language a regional variant falls back to. */
export function baseLanguage(code) {
  const c = normalizeLanguage(code);
  if (!c || !c.includes("-")) return null;
  return c.split("-")[0];
}

export function languageName(code) {
  const c = normalizeLanguage(code);
  if (!c) return code ?? "";
  return LANGUAGE_NAMES[c] || LANGUAGE_NAMES[baseLanguage(c)] || c;
}

/** Select options ("value:Label" lines) for a list of language codes. */
export function languageOptions(codes = Object.keys(LANGUAGE_NAMES)) {
  return codes.map((c) => `${c}:${languageName(c)}`).join("\n");
}

/**
 * Parses a language list stored as text (one per line or comma separated)
 * into normalized, unique codes.
 */
export function parseLanguageList(value) {
  const list = Array.isArray(value) ? value : String(value ?? "").split(/[\n,]/);
  const out = [];
  for (const item of list) {
    const c = normalizeLanguage(String(item).split(":")[0]);
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}

/** The provider the server installs (see core/server/i18n.js). */
export function setI18nProvider(provider) {
  globalThis[PROVIDER_KEY] = provider;
}

const clientProvider = {
  language() {
    return globalThis[CLIENT_KEY]?.language || DEFAULT_LANGUAGE;
  },
  messages() {
    return globalThis[CLIENT_KEY]?.messages || null;
  },
};

function provider() {
  return globalThis[PROVIDER_KEY] || clientProvider;
}

/** Language of the current request (server) or page (browser). */
export function currentLanguage() {
  return provider().language() || DEFAULT_LANGUAGE;
}

/** Fills `{0}` / `{name}` placeholders. Unknown placeholders are left as is. */
export function interpolate(text, args) {
  if (args == null || typeof text !== "string" || !text.includes("{")) return text;
  const values = Array.isArray(args) || typeof args === "object" ? args : [args];
  return text.replace(/\{(\w+)\}/g, (match, key) => {
    const v = values[key];
    return v === undefined || v === null ? match : String(v);
  });
}

/**
 * Translates `text` into the active language.
 * Non-strings (numbers, React nodes, null) are returned untouched, so a
 * label slot can be wrapped without checking its type first.
 *
 * @param {string} text   English source text (the key).
 * @param {Array|Object} [args]  Placeholder values.
 * @param {string} [language]    Force a language instead of the active one.
 */
export function __(text, args, language) {
  if (typeof text !== "string" || text === "") return text;
  const messages = provider().messages(language);
  const translated = messages ? messages[text] : undefined;
  return interpolate(typeof translated === "string" && translated !== "" ? translated : text, args);
}

/** True when `text` has a translation in the active language. */
export function hasTranslation(text, language) {
  const messages = provider().messages(language);
  return !!(messages && typeof messages[text] === "string" && messages[text] !== "");
}

export default __;

/** Props of a doc_structure node that hold interface text. */
const STRUCTURE_TEXT_PROPS = ["label", "description", "placeholder", "empty_message", "value_descriptive"];
/** Elements whose multi-line `options` are "value:Label" choices. */
const CHOICE_ELEMENTS = new Set(["select", "radio_group"]);

/** Translates the label part of "value:Label" option lines (one value per line). */
export function translateOptions(options, language) {
  if (typeof options !== "string" || !options.includes("\n")) return options;
  return options.split(/\r?\n/).map((line) => {
    const i = line.indexOf(":");
    const value = i >= 0 ? line.slice(0, i) : line;
    const label = i >= 0 ? line.slice(i + 1) : line;
    if (!label) return line;
    const t = __(label, null, language);
    return t === label ? line : `${value}:${t}`;
  }).join("\n");
}

/**
 * Translates the interface text of an entity's doc_structure (labels,
 * descriptions, placeholders, choice labels) in place and returns it.
 * Used on the meta the desk renders a form or list with; designers keep
 * receiving the English source.
 */
export function translateStructure(nodes, language) {
  if (!Array.isArray(nodes)) return nodes;
  for (const node of nodes) {
    const data = node?.data;
    if (data) {
      for (const prop of STRUCTURE_TEXT_PROPS) {
        if (typeof data[prop] === "string" && data[prop]) data[prop] = __(data[prop], null, language);
      }
      if (CHOICE_ELEMENTS.has(node.element)) data.options = translateOptions(data.options, language);
    }
    if (node?.elements) translateStructure(node.elements, language);
  }
  return nodes;
}

/** First URL segments that never carry a language prefix (non-website surfaces). */
const UNPREFIXED_SEGMENTS = new Set(["desk", "auth", "portal", "api", "loopar", "kiosk", "assets", "uploads", "app", "node_modules", "@vite", "@fs"]);

/**
 * Splits a website path into its language prefix and the plain page path:
 * "/es/pricing?x=1" → { language: "es", path: "/pricing?x=1" } when `es` is
 * one of `languages`; otherwise { language: null, path }.
 */
export function splitLanguagePrefix(path, languages = []) {
  if (typeof path !== "string" || !path.startsWith("/")) return { language: null, path };
  const match = path.match(/^\/([^/?#]+)(.*)$/);
  const code = match && normalizeLanguage(match[1]);
  if (code && languages.includes(code)) {
    const rest = match[2] || "";
    return { language: code, path: rest.startsWith("/") ? rest : `/${rest}` };
  }
  return { language: null, path };
}

/**
 * The URL of a website path in `language`: "/pricing" → "/es/pricing".
 * The site's default language has no prefix; non-website paths (desk,
 * auth, assets…), absolute URLs and anchors are returned unchanged.
 *
 * @param {string} path
 * @param {string} language
 * @param {{ default: string, languages: string[] }} site
 */
export function localizePath(path, language, site) {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || !site) return path;
  const languages = site.languages || [];
  const plain = splitLanguagePrefix(path, languages).path;
  const first = plain.split(/[/?#]/)[1] || "";
  if (UNPREFIXED_SEGMENTS.has(first.toLowerCase())) return plain;
  const code = normalizeLanguage(language);
  if (!code || code === site.default || !languages.includes(code)) return plain;
  return plain === "/" ? `/${code}` : `/${code}${plain}`;
}
