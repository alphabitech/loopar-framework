'use strict';

/**
 * Test runner shared by the TUI (Tests tab), the Debugger page and the
 * /api/Debugger/* surface. It runs the repo's `node:test` suite in a CHILD
 * process — never inside the core: integration tests boot throwaway tenants
 * under sites/ and force-exit — and turns the NDJSON of test-reporter.js
 * into a structured, incrementally updated run.
 *
 * Bare-mode safe (fs + child_process only): the TUI imports it without the
 * framework.
 *
 *   const run = runTests({ suite: 'unit', onEvent: (ev, state) => … });
 *   const result = await run.promise;      // same shape as run.state()
 *   run.cancel();
 *
 * Only files that listTestFiles() returns can be selected: a caller (the
 * API) can never point node at an arbitrary path.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { coreEnv } from '../config/core-config.js';

const REPORTER = fileURLToPath(new URL('./test-reporter.js', import.meta.url));

export const TEST_SUITES = Object.freeze({
  all: ['test/**/*.test.js'],
  unit: ['test/unit/**/*.test.js'],
  integration: ['test/integration/**/*.test.js'],
});

const MAX_TESTS = 5000;
const MAX_FAILURES = 500;
const MAX_OUTPUT = 400;
const toPosix = (p) => p.split(path.sep).join('/');

/** Every `*.test.js` under test/, as repo-relative posix paths. */
export function listTestFiles(root = process.cwd()) {
  const base = path.join(root, 'test');
  const out = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith('.test.js')) {
        const file = toPosix(path.relative(root, full));
        const suite = file.split('/')[1];
        out.push({ file, suite: suite === 'unit' || suite === 'integration' ? suite : 'other' });
      }
    }
  };
  walk(base);
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

/** Child env: the caller's, minus the PM2 process identity it may carry. */
function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const k of Object.keys(env)) {
    if (/^(pm_|PM2_|NODE_APP_INSTANCE$|unique_id$|axm_|automation$|autorestart$|exec_|instance_var$|vizion)/.test(k)) delete env[k];
  }
  // Started from inside a node:test process (our own unit test), the child
  // would otherwise report to that parent instead of through our reporter.
  delete env.NODE_TEST_CONTEXT;
  env.FORCE_COLOR = '0';
  return env;
}

// Throwaway tenants of integration tests (test/support/tenant.js and the
// install-wizard / install-rollback tests, which name their own).
const TEST_TENANT = /^__loopar_(test|wizard|rollback)_\d+__$/;

function testTenantDirs(root) {
  try {
    return fs.readdirSync(path.join(root, 'sites')).filter((n) => TEST_TENANT.test(n));
  } catch {
    return [];
  }
}

/**
 * Remove the test tenants a run left behind. teardown() removes its site, but
 * late async writes (theme, sessions) can recreate the folder after it — and
 * a leftover site is a tenant the registry would pick up.
 */
function removeLeftoverTenants(root, before) {
  const removed = [];
  for (const name of testTenantDirs(root)) {
    if (before.has(name)) continue;
    try {
      fs.rmSync(path.join(root, 'sites', name), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      removed.push(name);
    } catch { /* best effort */ }
  }
  // …and the backups they left (backups/<test tenant>/).
  let backups = [];
  try { backups = fs.readdirSync(path.join(root, 'backups')).filter((n) => TEST_TENANT.test(n) && !before.has(n)); } catch { /* none */ }
  for (const name of backups) fs.rmSync(path.join(root, 'backups', name), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  return removed;
}

function realRoot(root) {
  try { return fs.realpathSync(root); } catch { return root; }
}

/** Repo-relative path of a reported file; `roots` = [root, realpath(root)] (symlinked tmp dirs on macOS). */
function relFile(roots, file) {
  if (!file) return null;
  const f = file.startsWith('file://') ? fileURLToPath(file) : file;
  if (!path.isAbsolute(f)) return toPosix(f);
  for (const r of roots) {
    const rel = path.relative(r, f);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) return toPosix(rel);
  }
  return toPosix(f);
}

export class TestRun {
  constructor({ root, files, suite, namePattern }) {
    this.root = root;
    this.roots = [...new Set([root, realRoot(root)])];
    this.id = crypto.randomBytes(6).toString('hex');
    this.status = 'running';
    this.startedAt = new Date().toISOString();
    this.finishedAt = null;
    this.durationMs = null;
    this.exitCode = null;
    this.args = { files, suite, namePattern: namePattern || null };
    this.counts = { tests: 0, pass: 0, fail: 0, skip: 0, todo: 0, cancelled: 0 };
    this.files = {};
    this.tests = [];
    this.failures = [];
    this.output = [];
    this.current = null;
    this.#t0 = Date.now();
  }

  #t0;
  #stacks = new Map();

  #file(file) {
    const key = file || '(runner)';
    return (this.files[key] ??= { file: key, status: 'running', pass: 0, fail: 0, skip: 0, todo: 0, cancelled: 0, durationMs: 0 });
  }

  #pushOutput(stream, text, file) {
    for (const line of String(text ?? '').split('\n')) {
      if (!line) continue;
      this.output.push({ stream, file: file || null, text: line.length > 2000 ? `${line.slice(0, 2000)}…` : line });
    }
    if (this.output.length > MAX_OUTPUT) this.output.splice(0, this.output.length - MAX_OUTPUT);
  }

  /** Apply one reporter event (as parsed from a NDJSON line). */
  apply(ev) {
    const file = relFile(this.roots, ev.file);
    switch (ev.type) {
      case 'start': {
        const stack = this.#stacks.get(file) || [];
        stack[ev.nesting] = ev.name;
        stack.length = ev.nesting + 1;
        this.#stacks.set(file, stack);
        this.current = { name: ev.name, file };
        this.#file(file);
        return;
      }
      case 'pass':
      case 'fail': {
        if (ev.kind === 'suite') return;
        const stack = this.#stacks.get(file) || [];
        const ancestors = stack.slice(0, ev.nesting);
        const cancelled = ev.type === 'fail' && /cancelled/i.test(ev.error?.failureType || '');
        const status = ev.skip ? 'skip' : ev.todo ? 'todo' : cancelled ? 'cancelled' : ev.type;
        const f = this.#file(file);
        f[status]++;
        f.durationMs = Math.round((f.durationMs + (ev.durationMs || 0)) * 100) / 100;
        this.counts.tests++;
        this.counts[status]++;
        const test = {
          name: ev.name,
          path: ancestors.filter(Boolean),
          file,
          line: ev.line,
          status,
          durationMs: ev.durationMs != null ? Math.round(ev.durationMs * 100) / 100 : null,
        };
        if (this.tests.length < MAX_TESTS) this.tests.push(test);
        if (status === 'fail' && this.failures.length < MAX_FAILURES) this.failures.push({ ...test, error: ev.error || null });
        return;
      }
      case 'stdout':
      case 'stderr':
        this.#pushOutput(ev.type, ev.text, file);
        return;
      default:
        return;
    }
  }

  stderr(text) { this.#pushOutput('runner', text, null); }

  finish(status, exitCode) {
    this.status = status;
    this.exitCode = exitCode;
    this.finishedAt = new Date().toISOString();
    this.durationMs = Date.now() - this.#t0;
    this.current = null;
    for (const f of Object.values(this.files)) {
      f.status = f.fail > 0 ? 'failed' : f.cancelled > 0 ? 'cancelled' : 'passed';
    }
  }

  /** JSON-safe snapshot. `brief` drops the per-test list and the output. */
  toJSON({ brief = false } = {}) {
    const base = {
      id: this.id,
      status: this.status,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      durationMs: this.durationMs ?? Date.now() - this.#t0,
      exitCode: this.exitCode,
      args: this.args,
      counts: { ...this.counts },
      current: this.current,
      files: Object.values(this.files),
      failures: this.failures,
    };
    if (brief) return { ...base, files: undefined, failures: this.failures.map(({ name, path: p, file, line }) => ({ name, path: p, file, line })) };
    return { ...base, tests: this.tests, output: this.output };
  }
}

/**
 * Start a run.
 * @param {object}   opts
 * @param {string}   [opts.root=cwd]     repo root
 * @param {string[]} [opts.files]        subset of listTestFiles(); empty → `suite`
 * @param {string}   [opts.suite='all']  all | unit | integration
 * @param {string}   [opts.namePattern]  --test-name-pattern
 * @param {number}   [opts.timeoutMs]    hard stop (default 15 min)
 * @param {Function} [opts.onEvent]      (event, run) after every applied event
 */
export function runTests({ root = process.cwd(), files = [], suite = 'all', namePattern = null, timeoutMs = 15 * 60 * 1000, onEvent = null, env = {} } = {}) {
  if (!TEST_SUITES[suite]) throw new Error(`Unknown test suite "${suite}" (all | unit | integration).`);

  const known = new Set(listTestFiles(root).map((f) => f.file));
  const selected = [...new Set((files || []).map((f) => toPosix(String(f))))];
  const unknown = selected.filter((f) => !known.has(f));
  if (unknown.length) throw new Error(`Not a test file of this repo: ${unknown.join(', ')}`);
  if (namePattern != null && (typeof namePattern !== 'string' || namePattern.length > 300)) {
    throw new Error('namePattern must be a string of at most 300 characters.');
  }

  const run = new TestRun({ root, files: selected, suite: selected.length ? null : suite, namePattern });
  const args = ['--test', '--test-force-exit', `--test-reporter=${REPORTER}`, '--test-reporter-destination=stdout'];
  if (namePattern) args.push(`--test-name-pattern=${namePattern}`);
  args.push(...(selected.length ? selected : TEST_SUITES[suite]));

  const tenantsBefore = new Set(testTenantDirs(root));
  const child = spawn(process.execPath, args, { cwd: root, env: childEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
  const notify = (ev) => { try { onEvent?.(ev, run); } catch { /* a broken listener never stops the run */ } };

  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let ev = null;
      try { ev = JSON.parse(line); } catch { run.stderr(line); notify({ type: 'output', text: line }); continue; }
      run.apply(ev);
      notify(ev);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { run.stderr(chunk); notify({ type: 'output', text: chunk }); });

  let stopReason = null;
  const timer = setTimeout(() => { stopReason = 'timeout'; child.kill('SIGTERM'); }, timeoutMs);
  timer.unref?.();

  const promise = new Promise((resolve) => {
    child.on('error', (err) => {
      run.stderr(err?.message || String(err));
      stopReason ??= 'error';
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const removed = removeLeftoverTenants(root, tenantsBefore);
      if (removed.length) run.stderr(`removed leftover test tenants: ${removed.join(', ')}`);
      const status = stopReason === 'cancel' ? 'cancelled'
        : stopReason === 'timeout' ? 'timeout'
        : stopReason === 'error' ? 'error'
        : run.counts.fail > 0 || code !== 0 ? 'failed' : 'passed';
      run.finish(status, code);
      notify({ type: 'done', status });
      resolve(run.toJSON());
    });
  });

  return {
    id: run.id,
    run,
    promise,
    state: (opts) => run.toJSON(opts),
    cancel() {
      if (run.status !== 'running') return false;
      stopReason = 'cancel';
      child.kill('SIGTERM');
      return true;
    },
  };
}

/**
 * Test runs started from the core (Debugger page, API) are a development
 * tool: integration tests create and delete tenants under sites/, which a
 * production core must never do. (The TUI runs tests as the operator at the
 * terminal and is not bound by this.)
 */
export function testsAllowed() {
  return coreEnv() !== 'production';
}

/**
 * One-run-at-a-time manager for the core process (Debugger / API): keeps the
 * active run and the last few finished ones in memory.
 *
 * Runs belong to the tenant that started them (`meta.tenant`): another
 * tenant can't read, list or cancel them. Only one run executes at a time
 * for the whole core (they share the repo and the machine); a tenant that
 * hits a run of someone else just learns that one is in progress.
 */
class TestRunManager {
  #active = null;
  #history = [];
  maxHistory = 10;
  /** { wants(tenant), publish(tenant, action, payload) } — live progress to the tenant's Debugger (set by startCore). */
  stream = null;

  get active() { return this.#active; }

  start(opts = {}, meta = {}) {
    if (!testsAllowed()) {
      const err = new Error('Test runs are only available while the core runs in development mode.');
      err.status = 403;
      err.expose = true;
      throw err;
    }
    if (this.#active) {
      const mine = this.#active.meta?.tenant === meta.tenant;
      const err = new Error(mine
        ? `A test run is already in progress (${this.#active.id}).`
        : 'Another test run is in progress on this server; try again when it finishes.');
      err.status = 409;
      err.expose = true;
      throw err;
    }
    let handle = null;
    let sentTests = 0;
    let timer = null;
    // Live progress, throttled: the snapshot plus only the tests finished
    // since the previous push (the page appends them to its list).
    const push = (final = false) => {
      timer = null;
      const stream = this.stream;
      if (!handle || !stream || !meta.tenant) return;
      try {
        if (stream.wants && !stream.wants(meta.tenant)) return;
        const run = handle.run;
        const tests = run.tests.slice(sentTests);
        sentTests = run.tests.length;
        stream.publish(meta.tenant, 'test', {
          run: { ...run.toJSON({ brief: true }), files: Object.values(run.files), failures: run.failures, output: run.output.slice(-200), meta: handle.meta },
          tests,
          final,
        });
      } catch { /* a closed socket never breaks the run */ }
    };
    const onEvent = (ev) => {
      if (ev.type === 'done') { if (timer) clearTimeout(timer); push(true); return; }
      timer ??= setTimeout(push, 250);
    };

    handle = runTests({ ...opts, onEvent });
    handle.meta = { ...meta, requestedAt: new Date().toISOString() };
    this.#active = handle;
    handle.promise.finally(() => {
      if (this.#active === handle) this.#active = null;
      this.#history.unshift(handle);
      this.#history.length = Math.min(this.#history.length, this.maxHistory);
    });
    return handle;
  }

  #of(tenant) {
    return [this.#active, ...this.#history].filter((h) => h && h.meta?.tenant === tenant);
  }

  /** A run of `tenant` by id; without id, its active or latest run. */
  get(id, tenant) {
    const runs = this.#of(tenant);
    return id ? runs.find((h) => h.id === id) ?? null : runs[0] ?? null;
  }

  list(tenant) {
    return this.#of(tenant).map((h) => ({ ...h.state({ brief: true }), meta: h.meta }));
  }

  /** Cancel a run of `tenant` (default: its active one). */
  cancel(id, tenant) {
    const h = this.get(id, tenant);
    return h ? h.cancel() : false;
  }

  /** Is the core's single active run one of `tenant`'s? */
  activeFor(tenant) {
    return this.#active?.meta?.tenant === tenant ? this.#active : null;
  }
}

export const testRuns = new TestRunManager();
