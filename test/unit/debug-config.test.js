import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// core-config reads <cwd>/config/core.json once: each case runs in a child
// process inside a temp dir holding the core.json under test.
const CONFIG = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../packages/loopar/core/config/core-config.js")).href;

function debugEnabledWith(coreJson, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loopar-cfg-"));
  try {
    fs.mkdirSync(path.join(dir, "config"));
    fs.writeFileSync(path.join(dir, "config", "core.json"), JSON.stringify(coreJson));
    const childEnv = { ...process.env, ...env };
    delete childEnv.NODE_ENV;
    if (!("LOOPAR_DEBUG" in env)) delete childEnv.LOOPAR_DEBUG;
    const out = execFileSync(process.execPath, ["-e", `import(${JSON.stringify(CONFIG)}).then(m => process.stdout.write(String(m.debugEnabled())))`], { cwd: dir, env: childEnv });
    return out.toString() === "true";
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("debugEnabled(): unset → on in development, off in production", () => {
  assert.equal(debugEnabledWith({ nodeEnv: "development" }), true);
  assert.equal(debugEnabledWith({ nodeEnv: "production" }), false);
});

test("debugEnabled(): core.json `debug` and LOOPAR_DEBUG override the mode", () => {
  assert.equal(debugEnabledWith({ nodeEnv: "production", debug: true }), true);
  assert.equal(debugEnabledWith({ nodeEnv: "development", debug: false }), false);
  assert.equal(debugEnabledWith({ nodeEnv: "production" }, { LOOPAR_DEBUG: "1" }), true);
});
