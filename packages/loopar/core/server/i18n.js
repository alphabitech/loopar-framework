/**
 * Server side of the translation runtime (see core/global/i18n.js).
 *
 * Dictionaries are flat JSON files, "English source" → "translation":
 *   packages/loopar/translations/<lang>.json   framework strings (src/, core/)
 *   apps/<app>/translations/<lang>.json        each app's strings and labels
 *
 * A tenant's dictionary for a language merges the framework file, the files
 * of its installed apps in install order (a later app can override an
 * earlier one) and last the tenant's own overrides
 * (sites/<tenant>/translations/<lang>.json). A regional variant (es-mx) is
 * layered over its base language (es).
 *
 * The active language of a request is resolved once and memoized on the
 * request (see resolveRequestLanguage); `__()` anywhere downstream reads it
 * through the provider installed below.
 */
import fs from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { loopar } from "../loopar.js";
import { getRequest, getTenant } from "./router/request-context.js";
import { applyRecordLayer } from "../global/i18n-content.js";
import {
  DEFAULT_LANGUAGE,
  baseLanguage,
  normalizeLanguage,
  parseLanguageList,
  setI18nProvider,
} from "../global/i18n.js";

/** Cookie holding the signed-in user's desk language (set at login / profile save). */
export const LANGUAGE_COOKIE = "loopar-language";
/** Header the browser sends on RPC calls with the language of the page. */
export const LANGUAGE_HEADER = "x-loopar-language";

const REVALIDATE_MS = 2000;
const frameworkRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");

/** path → { mtimeMs, data } */
const fileCache = new Map();
/** `${tenant}|${lang}` → { at, files: [[path, mtimeMs]], messages } */
const mergedCache = new Map();

function readDictionary(file) {
  let stat;
  try { stat = fs.statSync(file); } catch { fileCache.delete(file); return null; }
  const cached = fileCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.data;
  let data = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed;
  } catch (e) {
    console.error(`[i18n] Invalid translation file ${file}: ${e.message}`);
  }
  fileCache.set(file, { mtimeMs: stat.mtimeMs, data });
  return data;
}

function appsRoot() {
  return loopar.makePath(loopar.pathRoot, "apps");
}

/** Installed apps of the current tenant, in install order (loopar first). */
function installedAppNames() {
  try {
    const apps = Object.keys(loopar.installedApps || {});
    if (apps.includes("loopar")) return ["loopar", ...apps.filter((a) => a !== "loopar")];
    return apps;
  } catch {
    return [];
  }
}

/** Dictionary files that make up `lang` for the current tenant, in merge order. */
export function dictionaryFiles(lang) {
  const files = [path.join(frameworkRoot, "translations", `${lang}.json`)];
  for (const app of installedAppNames()) {
    files.push(path.join(appsRoot(), app, "translations", `${lang}.json`));
  }
  // The tenant's own overrides (Translator, production): last, so they win.
  const tenantFile = tenantDictionaryFile(lang);
  if (tenantFile) files.push(tenantFile);
  return files;
}

/** sites/<tenant>/translations/<lang>.json — wording a site changes without touching any app. */
export function tenantDictionaryFile(lang) {
  try {
    return loopar.tenantPath ? loopar.makePath(loopar.tenantPath, "translations", `${lang}.json`) : null;
  } catch {
    return null;
  }
}

function mtimeOf(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

function mergeLanguage(lang) {
  const files = dictionaryFiles(lang);
  const messages = {};
  for (const file of files) {
    const data = readDictionary(file);
    if (!data) continue;
    for (const [k, v] of Object.entries(data)) {
      if (typeof v === "string" && v !== "") messages[k] = v;
    }
  }
  return { files: files.map((f) => [f, mtimeOf(f)]), messages };
}

/**
 * Merged dictionary of `lang` for the current tenant (base language layered
 * under a regional variant). Null when nothing translates `lang`.
 */
export function getMessages(lang) {
  const code = normalizeLanguage(lang);
  if (!code) return null;
  // The installed apps are part of the key: installing one adds its file.
  const key = `${getTenant()?.name ?? loopar.tenantId ?? ""}|${code}|${installedAppNames().join(",")}`;
  const now = Date.now();
  let entry = mergedCache.get(key);

  const stale = entry && now - entry.at > REVALIDATE_MS
    && entry.files.some(([f, m]) => mtimeOf(f) !== m);

  if (!entry || stale) {
    const base = baseLanguage(code);
    const own = mergeLanguage(code);
    const parent = base ? mergeLanguage(base) : { files: [], messages: {} };
    const messages = { ...parent.messages, ...own.messages };
    entry = {
      at: now,
      files: [...parent.files, ...own.files],
      messages: Object.keys(messages).length ? messages : null,
    };
    mergedCache.set(key, entry);
  } else if (now - entry.at > REVALIDATE_MS) {
    entry.at = now;
  }
  return entry.messages;
}

/** Drops the merged dictionaries (after an app install/update). */
export function invalidateTranslations() {
  mergedCache.clear();
}

/**
 * Languages that have a dictionary in the framework or any installed app,
 * plus English (the source language).
 */
const availableCache = new Map(); // tenant|apps → { at, list }

export function availableLanguages() {
  const key = `${getTenant()?.name ?? loopar.tenantId ?? ""}|${installedAppNames().join(",")}`;
  const cached = availableCache.get(key);
  if (cached && Date.now() - cached.at < REVALIDATE_MS) return cached.list;
  const found = new Set([DEFAULT_LANGUAGE]);
  const dirs = [path.join(frameworkRoot, "translations")];
  for (const app of installedAppNames()) dirs.push(path.join(appsRoot(), app, "translations"));
  const tenantFile = tenantDictionaryFile(DEFAULT_LANGUAGE);
  if (tenantFile) dirs.push(path.dirname(tenantFile));
  for (const dir of dirs) {
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const f of entries) {
      const code = f.endsWith(".json") && normalizeLanguage(f.slice(0, -5));
      if (code) found.add(code);
    }
  }
  const list = [...found].sort();
  availableCache.set(key, { at: Date.now(), list });
  return list;
}

/**
 * Languages a website publishes: its App `languages` list, always including
 * its `default_language` (English when the App sets none).
 */
export function siteLanguages(webApp = loopar.webApp) {
  const def = siteDefaultLanguage(webApp);
  const list = parseLanguageList(webApp?.languages);
  return list.includes(def) ? list : [def, ...list];
}

export function siteDefaultLanguage(webApp = loopar.webApp) {
  return normalizeLanguage(webApp?.default_language) || DEFAULT_LANGUAGE;
}

/**
 * The browser's preferred language (Accept-Language) that has a dictionary
 * here — exact ("es-mx") or its base ("es") — or null.
 */
export function browserLanguage(req) {
  const header = req?.headers?.["accept-language"];
  if (!header) return null;
  const wanted = String(header).split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      return { code: normalizeLanguage(tag), q: q ? Number(q.slice(2)) || 0 : 1 };
    })
    .filter((w) => w.code && w.q > 0)
    .sort((a, b) => b.q - a.q);
  const available = availableLanguages();
  for (const { code } of wanted) {
    if (available.includes(code)) return code;
    const base = baseLanguage(code);
    if (base && available.includes(base)) return base;
  }
  return null;
}

/**
 * A language for work that has no request of its own (jobs, e-mails to a
 * user): `withLanguage(user.language, () => sendMail(...))` makes __() and
 * the formatters use it inside `fn`.
 */
const languageScope = new AsyncLocalStorage();
export function withLanguage(language, fn) {
  return languageScope.run(normalizeLanguage(language) || DEFAULT_LANGUAGE, fn);
}

function readCookie(req, name) {
  if (req.cookies && name in req.cookies) return req.cookies[name];
  const header = req.headers?.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

/**
 * Language of a request that doesn't carry it in the URL (desk, auth,
 * portal, RPC): the page's language header (RPC), then the user's own
 * choice (cookie written at sign-in), then the browser's language when
 * there is a dictionary for it, then English.
 */
export function resolveRequestLanguage(req) {
  if (!req) return DEFAULT_LANGUAGE;
  if (req.__LANGUAGE__) return req.__LANGUAGE__;
  const candidates = [req.headers?.[LANGUAGE_HEADER], readCookie(req, LANGUAGE_COOKIE)];
  for (const c of candidates) {
    const code = normalizeLanguage(c);
    if (code) return (req.__LANGUAGE__ = code);
  }
  return (req.__LANGUAGE__ = browserLanguage(req) || DEFAULT_LANGUAGE);
}

export function requestLanguage() {
  return languageScope.getStore() || resolveRequestLanguage(getRequest());
}

/** Writes the desk-language cookie (empty language clears it). */
export function setLanguageCookie(language) {
  const code = normalizeLanguage(language);
  try {
    if (code) loopar.cookie.set(LANGUAGE_COOKIE, code, { httpOnly: false, path: "/", maxAge: 365 * 24 * 3600 * 1000, sameSite: "lax" });
    else loopar.cookie.remove(LANGUAGE_COOKIE, { path: "/" });
  } catch (e) {
    console.warn("[i18n] Could not write the language cookie:", e.message);
  }
  const req = getRequest();
  if (req) req.__LANGUAGE__ = code || browserLanguage(req) || DEFAULT_LANGUAGE;
}

/** What the page needs before hydration: language + its dictionary. */
export function clientI18nPayload(language = requestLanguage()) {
  return { language, messages: getMessages(language) || {}, regional: regionalFor(language) };
}

// ---- regional settings (Company) -------------------------------------------

const REGIONAL_TTL_MS = 60_000;
/** tenant → { at, value: { country, currency, timeZone, dateFormat } } */
const regionalCache = new Map();

/** Reads the Company's regional defaults into the tenant cache. Call before rendering. */
export async function loadRegional() {
  const key = getTenant()?.name ?? loopar.tenantId ?? "";
  const cached = regionalCache.get(key);
  if (cached && Date.now() - cached.at < REGIONAL_TTL_MS) return cached.value;
  let value = {};
  try {
    if (loopar.__installed__ && loopar.getRef("Company", false)) {
      const c = await loopar.db.getDoc("Company", null, ["country", "currency", "time_zone", "date_format"], { isSingle: 1 });
      value = { country: c?.country || null, currency: c?.currency || null, timeZone: c?.time_zone || null, dateFormat: c?.date_format || null };
    }
  } catch (e) {
    console.warn("[i18n] Company regional settings unavailable:", e.message);
  }
  regionalCache.set(key, { at: Date.now(), value });
  return value;
}

/** Forget the cached Company settings (after the Company is saved). */
export function invalidateRegional() {
  regionalCache.clear();
}

/** { locale, currency, timeZone, dateFormat } for `language` (sync; uses the cache). */
export function regionalFor(language = requestLanguage()) {
  const key = getTenant()?.name ?? loopar.tenantId ?? "";
  const c = regionalCache.get(key)?.value || {};
  const country = /^[A-Z]{2}$/.test(c.country || "") ? c.country : null;
  return {
    locale: country && !language.includes("-") ? `${language}-${country}` : language,
    currency: c.currency || null,
    timeZone: c.timeZone || null,
    dateFormat: c.dateFormat || null,
  };
}

setI18nProvider({
  language: requestLanguage,
  messages: (lang) => getMessages(lang || requestLanguage()),
  regional: () => regionalFor(),
});

/**
 * Languages website content can be translated into: every language a site
 * of the tenant publishes, except the content's base language (the default
 * site's default language). Feeds the desk's translation editors.
 */
export function contentLanguages() {
  const base = siteDefaultLanguage(loopar.webApp);
  const apps = [loopar.webApp, ...Object.values(loopar.webApps || {})].filter((a) => a?.name);
  const out = new Set();
  for (const app of apps) for (const code of siteLanguages(app)) if (code !== base) out.add(code);
  return { base, languages: [...out] };
}

/**
 * A record as the website shows it in the request's language: its
 * translatable fields (Entity ref `__TRANSLATABLE__`) replaced by their
 * translation, when there is one. In the site's default language, or for
 * entities without translatable fields, the row comes back as is.
 * Only for display: never save a row that went through here.
 */
export function translateRecord(entity, row, language = requestLanguage()) {
  if (!row || language === siteDefaultLanguage()) return row;
  const fields = loopar.getRef(entity, false)?.__TRANSLATABLE__;
  return fields?.length ? applyRecordLayer(row, fields, language) : row;
}

export function translateRecords(entity, rows, language = requestLanguage()) {
  if (!Array.isArray(rows) || language === siteDefaultLanguage()) return rows;
  return rows.map((row) => translateRecord(entity, row, language));
}
