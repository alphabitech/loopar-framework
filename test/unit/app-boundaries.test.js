/**
 * App boundaries: an app never imports another app's files.
 *
 * Apps reach each other by entity name — `loopar.getDocument()` for a record
 * and `loopar.api()` for what an entity exposes (`<entity>.api.js`) — so an
 * entity can move between modules or apps without breaking its callers.
 *
 * Scans every app present in apps/ (static imports, dynamic imports and
 * literal paths into another app's modules). An app's own tests are skipped:
 * they may load controllers by path to drive them. `apps/loopar` is the
 * framework's own app and may be imported.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const APPS = path.join(process.cwd(), "apps");
const FRAMEWORK_APPS = new Set(["loopar", "core"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "uploads", "test", "tests", "dist", "build"]);
const CODE = /\.(js|jsx|mjs|ts|tsx)$/;

const appNames = () => fs.readdirSync(APPS, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);

function* codeFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* codeFiles(path.join(dir, entry.name));
    } else if (CODE.test(entry.name)) {
      yield path.join(dir, entry.name);
    }
  }
}

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)(['"`])([^'"`]+)\1/g;

/** The other apps `file` (of `app`) reaches into, as "line: specifier". */
export function foreignImports(file, app, apps) {
  const source = fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
  const found = [];
  const lineOf = (index) => source.slice(0, index).split("\n").length;
  const foreign = (other) => other && other !== app && apps.has(other) && !FRAMEWORK_APPS.has(other);

  for (const match of source.matchAll(SPECIFIER)) {
    const specifier = match[2];
    let other = null;
    if (specifier.startsWith(".")) {
      const relative = path.relative(APPS, path.resolve(path.dirname(file), specifier));
      if (!relative.startsWith("..")) other = relative.split(path.sep)[0];
    } else {
      other = /(?:^|\/)apps\/([^/]+)\//.exec(specifier)?.[1] || null;
    }
    if (foreign(other)) found.push(`${lineOf(match.index)}: ${specifier}`);
  }

  // Paths built in code: path.join(root, "apps", "<other>", ...).
  for (const match of source.matchAll(/["'`]apps["'`]\s*,\s*["'`]([^"'`]+)["'`]\s*,\s*["'`]modules["'`]/g)) {
    if (foreign(match[1])) found.push(`${lineOf(match.index)}: apps/${match[1]}/modules`);
  }
  return found;
}

test("no app imports another app's files", () => {
  const apps = new Set(appNames());
  const violations = [];
  for (const app of apps) {
    for (const file of codeFiles(path.join(APPS, app))) {
      for (const hit of foreignImports(file, app, apps)) {
        violations.push(`${path.relative(process.cwd(), file)}:${hit}`);
      }
    }
  }
  assert.deepEqual(violations, [], `Use loopar.getDocument() / loopar.api() instead of importing another app's files:\n${violations.join("\n")}`);
});
