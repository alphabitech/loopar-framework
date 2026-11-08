'use strict';

import fs from 'node:fs';
import { loopar, availableLanguages, contentLanguages, requestLanguage, invalidateTranslations, LANGUAGE_NAMES, normalizeLanguage } from 'loopar';
import { buildCatalog, targetPaths, readDictionary, writeDictionary, machineKeys, MACHINE_KEY } from 'loopar/core/i18n/catalog.js';
import { tenantDictionaryFile } from 'loopar/core/server/i18n.js';
import { readRuntimeMode } from 'loopar/core/server/runtime-mode.js';

/**
 * Translator: edits translation dictionaries from the desk.
 *   - In development, an app's own file (apps/<app>/translations/<lang>.json)
 *     — it travels with the app like its pages and entities.
 *   - Always, the site's overrides (sites/<tenant>/translations/<lang>.json):
 *     wording this site changes without touching any app (production too).
 */

const isDevelopment = () => readRuntimeMode() !== 'production';
const root = () => loopar.pathRoot;

export function installedTargets() {
  const apps = Object.keys(loopar.installedApps || {});
  const ordered = apps.includes('loopar') ? ['loopar', ...apps.filter((a) => a !== 'loopar')] : apps;
  return ['framework', ...ordered];
}

export function translatorContext() {
  const { languages: siteLanguages } = contentLanguages();
  const current = requestLanguage();
  const known = new Set([...availableLanguages(), ...siteLanguages, current].filter((l) => l && l !== 'en'));
  return {
    targets: installedTargets(),
    languages: [...known].sort(),
    allLanguages: Object.keys(LANGUAGE_NAMES).filter((l) => l !== 'en'),
    defaultLanguage: current !== 'en' ? current : [...known][0] || 'es',
    development: isDevelopment(),
  };
}

export function assertTarget(target) {
  if (!installedTargets().includes(target)) loopar.throw({ code: 400, message: 'Unknown app.' });
}

export function assertLanguage(lang) {
  const code = normalizeLanguage(lang);
  if (!code || code === 'en') loopar.throw({ code: 400, message: 'Choose a language other than English.' });
  return code;
}

/** Catalog of `target` in `lang`, with this site's overrides on top. */
export function catalogFor(target, lang) {
  const catalog = buildCatalog(root(), target, lang);
  const overrides = readDictionary(tenantDictionaryFile(lang));
  const overrideMachine = machineKeys(overrides);
  for (const e of catalog.entries) {
    if (typeof overrides[e.key] === 'string' && overrides[e.key]) {
      e.override = overrides[e.key];
      if (overrideMachine.has(e.key)) e.overrideMachine = true;
    }
  }
  return { ...catalog, development: isDevelopment() };
}

/**
 * Applies `changes` ({ text: translation | "" | null }) to the app's file
 * ("app", development only) or to the site's overrides ("site").
 * "" leaves a key untranslated, null removes it (unused keys, overrides).
 * `machine`: keys whose new value is an unreviewed AI translation;
 * `reviewed`: keys a person accepted as they are. Any other edited key
 * is a person's translation, so it stops being "machine".
 */
export function saveChanges(target, lang, changes, where, { machine = [], reviewed = [] } = {}) {
  let file;
  if (where === 'app') {
    if (!isDevelopment()) {
      loopar.throw({ code: 403, message: "Apps' translations are files of the app: edit them in development and deploy. On this site, save them as site overrides." });
    }
    file = targetPaths(root(), target, lang).file;
  } else {
    file = tenantDictionaryFile(lang);
    if (!file) loopar.throw({ code: 400, message: 'This site has no folder for translations.' });
  }

  const dict = fs.existsSync(file) ? readDictionary(file) : {};
  const marked = machineKeys(dict);
  const fromAI = new Set(machine);
  let changed = 0;
  for (const [key, value] of Object.entries(changes || {})) {
    if (typeof key !== 'string' || key.length > 600) continue;
    if (value === null || (where === 'site' && value === '')) {
      if (key in dict) { delete dict[key]; changed++; }
    } else if (typeof value === 'string' && dict[key] !== value) {
      dict[key] = value;
      changed++;
    }
    if (fromAI.has(key)) marked.add(key);
    else marked.delete(key);
  }
  for (const key of reviewed) {
    if (marked.delete(key)) changed++;
  }
  dict[MACHINE_KEY] = [...marked];
  if (changed) {
    writeDictionary(file, dict);
    invalidateTranslations();
  }
  return { changed };
}
