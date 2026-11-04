/**
 * Tests tab — run the repo's node:test suite from the TUI and follow it live.
 *
 * Same runner as the Debugger page and /api/Debugger/runTests
 * (packages/loopar/core/debug/test-runner.js): a child `node --test` with an
 * NDJSON reporter, parsed into counts, per-file status and failures with
 * their assertion diff. The run keeps going if you switch tabs; leaving the
 * TUI stops it.
 *
 * Keys (tests view):
 *   ↑↓ move · space pick · Enter run picked (or the file under the cursor)
 *   a all · u unit · i integration · f re-run failed files · x stop
 *   PgUp/PgDn scroll results · Tab/Esc back to tenants
 */
import { runTests, listTestFiles } from "loopar/core/debug/test-runner.js";
import { state } from "./state.js";
import { render } from "./render.js";

let renderQueued = false;
let exitHook = false;

function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  setTimeout(() => {
    renderQueued = false;
    if (state.view === "tests") render();
  }, 100);
}

function T() {
  state.tests ??= {
    files: [],
    cursor: 0,
    scroll: 0,
    picked: new Set(),
    handle: null, // runTests() handle of the current/last run
    detailScroll: 0,
    listH: 10, // set by render
  };
  return state.tests;
}

export function openTests() {
  const t = T();
  t.files = listTestFiles(process.cwd());
  t.cursor = Math.min(t.cursor, Math.max(0, t.files.length - 1));
  state.view = "tests";
  if (!t.handle) {
    state.message = t.files.length
      ? "a all · u unit · i integration · Enter selected · f failed"
      : "no test files under test/";
    state.messageKind = "info";
  }
  render();
}

export function closeTests() {
  state.view = "tenants";
}

export const testsRunning = () => state.tests?.handle?.run?.status === "running";

function start(opts, label) {
  const t = T();
  if (testsRunning()) {
    state.message = "a run is already in progress — x stops it";
    state.messageKind = "error";
    return render();
  }
  let handle;
  try {
    handle = runTests({ root: process.cwd(), ...opts, onEvent: scheduleRender });
  } catch (err) {
    state.message = err.message || String(err);
    state.messageKind = "error";
    return render();
  }
  t.handle = handle;
  t.detailScroll = 0;
  state.message = `running ${label}…`;
  state.messageKind = "info";

  if (!exitHook) {
    exitHook = true;
    process.on("exit", () => { try { state.tests?.handle?.cancel(); } catch { /* already gone */ } });
  }

  handle.promise.then((result) => {
    if (t.handle !== handle) return;
    const c = result.counts;
    state.message = `${result.status} · ${c.pass} passed · ${c.fail} failed${c.skip ? ` · ${c.skip} skipped` : ""} · ${(result.durationMs / 1000).toFixed(1)}s`;
    state.messageKind = result.status === "passed" ? "ok" : "error";
    render();
  });
  render();
}

export const runAll = () => start({ suite: "all" }, "all tests");
export const runUnit = () => start({ suite: "unit" }, "unit tests");
export const runIntegration = () => start({ suite: "integration" }, "integration tests");

export function runSelection() {
  const t = T();
  const files = t.picked.size ? [...t.picked] : (t.files[t.cursor] ? [t.files[t.cursor].file] : []);
  if (!files.length) return;
  start({ files }, files.length === 1 ? files[0] : `${files.length} files`);
}

export function runFailed() {
  const t = T();
  const failed = (t.handle?.run ? Object.values(t.handle.run.files) : [])
    .filter((f) => f.fail > 0 && f.file !== "(runner)")
    .map((f) => f.file);
  if (!failed.length) {
    state.message = "no failed files in the last run";
    state.messageKind = "info";
    return render();
  }
  start({ files: failed }, `${failed.length} failed file${failed.length > 1 ? "s" : ""}`);
}

export function stopRun() {
  const h = state.tests?.handle;
  if (h?.cancel()) {
    state.message = "stopping…";
    state.messageKind = "info";
  }
  render();
}

export function moveCursor(delta) {
  const t = T();
  t.cursor = Math.min(Math.max(0, t.cursor + delta), Math.max(0, t.files.length - 1));
  render();
}

export function togglePick() {
  const t = T();
  const f = t.files[t.cursor];
  if (!f) return;
  t.picked.has(f.file) ? t.picked.delete(f.file) : t.picked.add(f.file);
  render();
}

export function scrollDetail(delta) {
  const t = T();
  t.detailScroll = Math.max(0, t.detailScroll + delta);
  render();
}
