/**
 * Translation catalog of an app (or of the framework): which strings it
 * introduces, where they are used, and their state in a language.
 * Shared by `yarn i18n:extract` and the desk's Translator page.
 *
 *   packages/loopar/translations/<lang>.json   target "framework"
 *   apps/<app>/translations/<lang>.json        target "<app>"
 *   sites/<tenant>/translations/<lang>.json    tenant overrides (Translator only)
 *
 * Strings are owned by whoever ships them, but resolved globally: an app
 * does not carry strings the framework, the core app or the apps it
 * requires already translate.
 *
 * Sources of strings:
 *   - code: first argument of __("…") / loopar.__("…"), literal messages of
 *     loopar.throw / notify / confirm / alert and this.success / this.error;
 *   - definitions (modules/<m>/entities|forms|reports/<n>/<n>.json): entity
 *     name, labels, descriptions, placeholders, choice labels;
 *   - installer.json: module and app descriptions, website menu labels.
 * Website page content is not collected: pages have their own layers.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const LANGUAGE_RE = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/;
const MAX_SOURCES = 5;

export const isLanguageCode = (code) => typeof code === "string" && LANGUAGE_RE.test(code);

/**
 * Reserved key of a dictionary: the texts whose translation came from the
 * AI and nobody reviewed yet. The runtime ignores it (not a string).
 */
export const MACHINE_KEY = "__machine__";

/** Keys of `dict` marked as unreviewed machine translations. */
export const machineKeys = (dict) => new Set(Array.isArray(dict?.[MACHINE_KEY]) ? dict[MACHINE_KEY] : []);

function loadBabel() {
  const parser = require("@babel/parser");
  const traverse = require("@babel/traverse").default;
  return { parse: parser.parse, traverse };
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "uploads", "public", "translations", "test", "tests"]);
function walk(dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p, out); }
    else out.push(p);
  }
  return out;
}

/** Paths of a target: where its code and definitions live and its dictionary file. */
export function targetPaths(root, target, lang) {
  const frameworkRoot = path.join(root, "packages/loopar");
  if (target === "framework") {
    return {
      codeRoots: ["src", "core", "apps"].map((d) => path.join(frameworkRoot, d)).concat(path.join(root, "app")),
      definitionRoots: [path.join(frameworkRoot, "apps")],
      appRoot: null,
      file: lang && path.join(frameworkRoot, "translations", `${lang}.json`),
    };
  }
  const appRoot = path.join(root, "apps", target);
  return { codeRoots: [appRoot], definitionRoots: [appRoot], appRoot, file: lang && path.join(appRoot, "translations", `${lang}.json`) };
}

export function readDictionary(file) {
  try {
    const d = JSON.parse(fs.readFileSync(file, "utf8"));
    return d && typeof d === "object" && !Array.isArray(d) ? d : {};
  } catch {
    return {};
  }
}

/** Sorted, pretty, stable: dictionaries are meant to be reviewed in diffs. */
export function writeDictionary(file, dict) {
  const machine = [...machineKeys(dict)].filter((k) => typeof dict[k] === "string" && dict[k]).sort();
  const keys = Object.keys(dict).filter((k) => k !== MACHINE_KEY).sort((a, b) => a.localeCompare(b, "en"));
  const sorted = Object.fromEntries(keys.map((k) => [k, dict[k]]));
  if (machine.length) sorted[MACHINE_KEY] = machine;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(sorted, null, 2) + "\n");
}

// ---- collection --------------------------------------------------------------

const MESSAGE_CALLS = new Set(["throw", "notify", "confirm", "alert"]);
const TEXT_PROPS = ["label", "description", "placeholder", "empty_message"];
const CHOICES = new Set(["select", "radio_group"]);
const DEFINITION_DIRS = new Set(["entities", "forms", "reports"]);
const LAYOUT_LABEL = /^(row|col|column|section|card|panel|tabs?|div|generic|slot)\s*[\w-]*\d*$/i;
/** Designer auto-labels and identifiers ("Row1", "LinkCol2", "__Builder__", "zone_protection", "P5v9gdbzl"). */
const NOT_TEXT = (v) => LAYOUT_LABEL.test(v)
  || (/^[A-Za-z0-9]{6,12}$/.test(v) && /\d/.test(v) && /[a-z]/.test(v))
  || /^__.*__$/.test(v)
  || (!/\s/.test(v) && (/_/.test(v) || /^[A-Za-z]+\d+$/.test(v) || (/[a-z][A-Z]/.test(v) && /\d/.test(v))));
/** Code lists (time zones, currencies, countries) stay as they are. */
const MAX_CHOICES = 60;
const TRUE = [1, "1", true, "true"];

/**
 * Strings a target introduces: Map<text, { sources: string[] }>, sources
 * relative to `root` ("apps/gym/modules/…/member.json").
 */
export function collectStrings(root, target) {
  const { codeRoots, definitionRoots, appRoot } = targetPaths(root, target);
  const { parse, traverse } = loadBabel();
  const keys = new Map();
  const add = (text, source) => {
    if (typeof text !== "string") return;
    const t = text.trim();
    if (!t || !/[A-Za-z]{2,}/.test(t) || t.length > 600) return;
    const entry = keys.get(t) || { sources: [] };
    if (source && entry.sources.length < MAX_SOURCES && !entry.sources.includes(source)) entry.sources.push(source);
    keys.set(t, entry);
  };
  const literal = (node) => {
    if (!node) return null;
    if (node.type === "StringLiteral") return node.value;
    if (node.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis[0].value.cooked;
    return null;
  };

  for (const file of codeRoots.flatMap((r) => walk(r)).filter((f) => /\.(m?js|jsx|tsx?)$/.test(f))) {
    const src = fs.readFileSync(file, "utf8");
    if (!/__\(|throw\(|notify\(|confirm\(|alert\(|success\(|error\(/.test(src)) continue;
    let ast;
    try {
      ast = parse(src, {
        sourceType: "module", errorRecovery: true,
        plugins: ["jsx", "classProperties", "classPrivateProperties", "classPrivateMethods", "topLevelAwait", "importAttributes", ...(/\.tsx?$/.test(file) ? ["typescript"] : [])],
      });
    } catch { continue; }
    const rel = path.relative(root, file);
    traverse(ast, {
      CallExpression(p) {
        const { callee, arguments: args } = p.node;
        const name = callee.type === "Identifier" ? callee.name
          : callee.type === "MemberExpression" && callee.property.type === "Identifier" ? callee.property.name : null;
        if (!name) return;
        const objName = callee.type === "MemberExpression"
          ? (callee.object.type === "Identifier" ? callee.object.name : callee.object.type === "ThisExpression" ? "this" : null)
          : null;
        if (name === "__") return add(literal(args[0]), rel);
        if (MESSAGE_CALLS.has(name) && objName === "loopar") {
          const a = args[0];
          add(literal(a), rel);
          if (a?.type === "ObjectExpression") {
            for (const prop of a.properties) {
              if (prop.type === "ObjectProperty" && ["message", "title", "content"].includes(prop.key?.name)) add(literal(prop.value), rel);
            }
          }
          if (name === "throw") add(literal(args[1]), rel);
        }
        if ((name === "success" || name === "error") && objName === "this") add(literal(args[0]), rel);
      },
    });
  }

  const collectStructure = (nodes, rel) => {
    for (const n of Array.isArray(nodes) ? nodes : []) {
      const d = n?.data || {};
      for (const prop of TEXT_PROPS) {
        const v = d[prop];
        if (typeof v === "string" && !(prop === "label" && NOT_TEXT(v.trim()))) add(v, rel);
      }
      const lines = typeof d.options === "string" ? d.options.split(/\r?\n/) : [];
      if (CHOICES.has(n?.element) && lines.length > 1 && lines.length <= MAX_CHOICES) {
        for (const line of lines) {
          const i = line.indexOf(":");
          add(i >= 0 ? line.slice(i + 1) : line, rel);
        }
      }
      collectStructure(n?.elements, rel);
    }
  };

  for (const file of definitionRoots.flatMap((r) => walk(r)).filter((f) => f.endsWith(".json"))) {
    const parts = file.split(path.sep);
    const base = path.basename(file, ".json");
    if (parts.at(-2) !== base) continue;
    const kind = parts.at(-3);
    // Pages: only their name (sidebar, palette); their content has its own layers.
    if (!DEFINITION_DIRS.has(kind) && kind !== "pages") continue;
    let def;
    try { def = JSON.parse(fs.readFileSync(file, "utf8")); } catch { continue; }
    const rel = path.relative(root, file);
    if (kind === "pages") { add(def.name, rel); continue; }
    if (parts.at(-3) === "entities") add(def.name, rel);
    let structure = def.doc_structure;
    if (typeof structure === "string") { try { structure = JSON.parse(structure); } catch { structure = []; } }
    collectStructure(structure, rel);
  }

  if (appRoot) {
    const rel = path.relative(root, path.join(appRoot, "installer.json"));
    try {
      const installer = JSON.parse(fs.readFileSync(path.join(appRoot, "installer.json"), "utf8"));
      for (const [key, doc] of Object.entries(installer.documents || {})) {
        if (key.startsWith("Module:") || key.startsWith("App:")) add(doc?.description, rel);
        if (key.startsWith("App:")) {
          for (const item of doc?.menu_items || []) if (!TRUE.includes(item.router_only)) add(item.link, rel);
          for (const action of doc?.menu_actions || []) add(action.label, rel);
        }
      }
    } catch { /* app without installer */ }
  }

  return keys;
}

/** Apps a target builds on: the framework, the core app, and its `requires` (transitively). */
export function dependenciesOf(root, target) {
  if (target === "framework") return [];
  const deps = ["framework"];
  if (target !== "loopar") deps.push("loopar");
  const seen = new Set(deps);
  const queue = [target];
  while (queue.length) {
    const app = queue.shift();
    let requires = "";
    try {
      const installer = JSON.parse(fs.readFileSync(path.join(root, "apps", app, "installer.json"), "utf8"));
      requires = Object.entries(installer.documents || {}).find(([k]) => k === `App:${app}`)?.[1]?.requires || "";
    } catch { /* none */ }
    for (const dep of String(requires).split(/[\s,]+/).filter(Boolean)) {
      if (!seen.has(dep) && dep !== target) { seen.add(dep); deps.push(dep); queue.push(dep); }
    }
  }
  return deps;
}

/** { text: { translation, provider } } of every dependency of `target` in `lang`. */
export function inheritedTranslations(root, target, lang) {
  const out = {};
  for (const dep of dependenciesOf(root, target)) {
    const dict = readDictionary(targetPaths(root, dep, lang).file);
    for (const [k, v] of Object.entries(dict)) if (typeof v === "string" && v) out[k] = { translation: v, provider: dep };
  }
  return out;
}

// ---- suggestions for edited source texts --------------------------------------

const bigrams = (s) => {
  const t = ` ${s.toLowerCase().replace(/\s+/g, " ")} `;
  const out = new Map();
  for (let i = 0; i < t.length - 1; i++) { const g = t.slice(i, i + 2); out.set(g, (out.get(g) || 0) + 1); }
  return out;
};

/** Dice coefficient of two strings (0..1). */
export function similarity(a, b) {
  if (a === b) return 1;
  const A = bigrams(a), B = bigrams(b);
  let inter = 0, size = 0;
  for (const [g, n] of A) { size += n; if (B.has(g)) inter += Math.min(n, B.get(g)); }
  for (const n of B.values()) size += n;
  return size ? (2 * inter) / size : 0;
}

/**
 * For each untranslated key, the closest orphan (a translated key no longer
 * used — usually the old wording of the same text), when close enough:
 * { newKey: { from: oldKey, translation, score } }.
 */
export function suggestFromOrphans(missing, orphans, threshold = 0.6) {
  const out = {};
  for (const key of missing) {
    let best = null;
    for (const [old, translation] of orphans) {
      const score = similarity(key, old);
      if (score >= threshold && (!best || score > best.score)) best = { from: old, translation, score: Math.round(score * 100) / 100 };
    }
    if (best) out[key] = best;
  }
  return out;
}

/**
 * Full state of a target's dictionary in `lang`:
 * entries: [{ key, translation, status, sources, provider, suggestion }]
 *   status: "translated" | "missing" | "inherited" (a dependency translates
 *   it) | "orphan" (translated here, no longer used)
 */
export function buildCatalog(root, target, lang) {
  const strings = collectStrings(root, target);
  const { file } = targetPaths(root, target, lang);
  const own = readDictionary(file);
  const machine = machineKeys(own);
  const inherited = inheritedTranslations(root, target, lang);

  const entries = [];
  const missing = [];
  for (const [key, { sources }] of strings) {
    const mine = own[key];
    if (typeof mine === "string" && mine) entries.push({ key, translation: mine, status: "translated", sources, provider: target, ...(machine.has(key) ? { machine: true } : {}) });
    else if (inherited[key]) entries.push({ key, translation: inherited[key].translation, status: "inherited", sources, provider: inherited[key].provider });
    else { entries.push({ key, translation: "", status: "missing", sources, provider: null }); missing.push(key); }
  }
  const orphans = Object.entries(own).filter(([k, v]) => k !== MACHINE_KEY && !strings.has(k) && typeof v === "string" && v);
  for (const [key, translation] of orphans) entries.push({ key, translation, status: "orphan", sources: [], provider: target });

  const suggestions = suggestFromOrphans(missing, orphans);
  for (const e of entries) if (suggestions[e.key]) e.suggestion = suggestions[e.key];

  return { target, lang, file: path.relative(root, file), entries };
}

/**
 * Writes the target's dictionary from the catalog: keeps translations,
 * adds new keys empty (not inherited ones), drops orphans when `prune`.
 * Returns counts.
 */
export function syncDictionary(root, target, lang, { prune = false } = {}) {
  const catalog = buildCatalog(root, target, lang);
  const { file } = targetPaths(root, target, lang);
  const own = readDictionary(file);
  const next = {};
  let added = 0;
  for (const e of catalog.entries) {
    if (e.status === "inherited") continue;
    if (e.status === "orphan") { if (!prune) next[e.key] = e.translation; continue; }
    if (!(e.key in own)) added++;
    next[e.key] = own[e.key] || "";
  }
  next[MACHINE_KEY] = [...machineKeys(own)];
  writeDictionary(file, next);
  const count = (s) => catalog.entries.filter((e) => e.status === s).length;
  return {
    file: catalog.file, added, strings: catalog.entries.filter((e) => e.status !== "orphan").length,
    missing: count("missing"), inherited: count("inherited"), orphans: count("orphan"),
    suggestions: catalog.entries.filter((e) => e.suggestion).length, pruned: prune,
  };
}
