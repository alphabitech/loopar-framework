#!/usr/bin/env node
/**
 * Adds the strings an app (or the framework) introduces to its dictionary,
 * with an empty translation (see core/i18n/catalog.js):
 *
 *   yarn i18n:extract <app|framework> <lang> [--prune]
 *
 * Existing translations are never touched. Strings the framework, the core
 * app or the apps it requires already translate are not added. Keys no
 * longer used are reported (removed with --prune), and a new key close to
 * one of them is reported as a suggestion — usually an edited text; the
 * desk's Translator page lets you apply it.
 */
import fs from "node:fs";
import path from "node:path";
import { syncDictionary, isLanguageCode } from "../../core/i18n/catalog.js";

const [target, lang, ...flags] = process.argv.slice(2);
const root = process.cwd();

if (!target || !isLanguageCode(lang)) {
  console.error("Usage: yarn i18n:extract <app|framework> <lang> [--prune]   e.g. yarn i18n:extract loopar es");
  process.exit(1);
}
if (target !== "framework" && !fs.existsSync(path.join(root, "apps", target))) {
  console.error(`App "${target}" not found in apps/.`);
  process.exit(1);
}

const r = syncDictionary(root, target, lang, { prune: flags.includes("--prune") });
console.log(
  `${r.file}: ${r.strings} strings, ${r.added} new, ${r.missing} untranslated, ${r.inherited} from dependencies` +
  (r.orphans ? `, ${r.orphans} no longer used${r.pruned ? " (removed)" : " (kept, use --prune)"}` : "") +
  (r.suggestions ? `, ${r.suggestions} with a suggested translation (see Translator)` : "")
);
