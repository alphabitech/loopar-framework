'use strict';

/**
 * Debug collector — the data behind the Debugger (desk page, toolbar chip
 * and /api/Debugger/*). Yii-debug style: per request it records the route,
 * user, timing, every SQL statement (with redacted bindings), what was
 * logged and what failed; plus process-wide logs, errors and the queries
 * that ran outside a request (jobs, boot).
 *
 * Storage is in memory, one bounded bucket per tenant: a tenant only ever
 * reads its own bucket. Requests without a tenant and core-level output go
 * to the `__core__` bucket, which no tenant can read. Everything is lost on
 * restart by design — this is a development tool, not an audit log.
 *
 * Wiring (done once by startCore):
 *   - `middleware()` right after tenant resolution: opens the request entry
 *     on `req.__DEBUG__`, stamps `X-Loopar-Debug: <id>` on the response.
 *   - a db-env query probe: knex events arrive in the caller's async
 *     context, so a query is attributed to the request whose ALS store is
 *     live (transactions and fire-and-forget hooks included).
 *   - console.* wrappers and `uncaughtExceptionMonitor` (observes, never
 *     changes, the process' crash behavior).
 *   - the router's error middleware calls `recordError()`.
 *   - an optional `stream` ({ wants(tenant), publish(tenant, action, payload) })
 *     pushes what gets recorded to whoever watches (the Debugger page over the
 *     realtime socket), batched every STREAM_MS — so the page doesn't poll.
 *
 * Off (the default in production) everything returns early: no entries, no
 * console formatting, no query bookkeeping.
 */

import util from 'node:util';
import crypto from 'node:crypto';
import { requestContext } from '../server/router/request-context.js';
import { debugEnabled } from '../config/core-config.js';
import { redactBindings, redactObject, redactUrl, scrubText, pickHeaders, clip } from './redact.js';

export const DEBUG_LIMITS = Object.freeze({
  requests: 300,           // request entries kept per tenant
  queriesPerRequest: 500,
  logsPerRequest: 200,
  errorsPerRequest: 50,
  logs: 1500,              // log lines kept per tenant
  errors: 300,             // errors kept per tenant
  background: 300,         // out-of-request queries kept per tenant
  sqlChars: 4000,
  logChars: 8000,
  stackChars: 8000,
  slowQueryMs: 100,        // a query at least this slow is flagged
  repeatedQuery: 5,        // same statement this many times in one request → possible N+1
  pending: 5000,           // in-flight queries tracked before giving up on stragglers
});

export const CORE_BUCKET = '__core__';
const STREAM_MS = 400;

const LEVELS = ['log', 'info', 'warn', 'error', 'debug'];
const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

const nowMs = () => Number(process.hrtime.bigint()) / 1e6;
const round = (n) => Math.round(n * 100) / 100;
const newId = () => crypto.randomBytes(6).toString('hex');
const lower = (v) => String(v ?? '').toLowerCase();

class Ring {
  constructor(max) { this.max = max; this.items = []; }
  push(item) {
    this.items.push(item);
    if (this.items.length > this.max) this.items.splice(0, this.items.length - this.max);
  }
  clear() { this.items = []; }
  get size() { return this.items.length; }
  /** Newest first. */
  newest() { return this.items.slice().reverse(); }
}

function rowCount(response) {
  if (Array.isArray(response)) {
    // mysql2 raw → [rows, fields]
    if (response.length === 2 && Array.isArray(response[0]) && Array.isArray(response[1])) return response[0].length;
    return response.length;
  }
  if (typeof response === 'number') return response;
  if (response && Array.isArray(response.rows)) return response.rows.length;
  if (response && typeof response.rowCount === 'number') return response.rowCount;
  if (response && typeof response.changes === 'number') return response.changes;
  return null;
}

function toTime(since) {
  if (since === undefined || since === null || since === '') return null;
  if (typeof since === 'number') return since;
  const n = Number(since);
  if (!Number.isNaN(n)) return n;
  const t = Date.parse(since);
  return Number.isNaN(t) ? null : t;
}

function matchesStatus(status, filter) {
  if (filter === undefined || filter === null || filter === '') return true;
  const f = lower(filter);
  if (f === 'error' || f === 'errors') return status >= 500;
  if (/^[1-5]xx$/.test(f)) return Math.floor(status / 100) === Number(f[0]);
  return Number(f) === status;
}

/**
 * Knex rewrites a failed query's error message to `<SQL with the bindings
 * interpolated> - <driver message>`: the values (password hashes, secrets)
 * would land in the debugger verbatim. Keep the driver's part only.
 */
function driverMessage(err) {
  const msg = String(err?.message ?? err ?? '');
  const native = err?.nativeError?.message ?? err?.sqlMessage;
  if (native) return String(native);
  const i = msg.lastIndexOf(' - ');
  return i >= 0 ? msg.slice(i + 3) : msg;
}

const clampInt = (value, def, min, max) => {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(n, min), max);
};

/** Same statement shape, ignoring bindings. */
const shapeOf = (sql) => String(sql || '').replace(/\s+/g, ' ').trim();

function analyse(queries) {
  const identical = new Map();
  const shapes = new Map();
  for (const q of queries) {
    const shape = shapeOf(q.sql);
    const key = `${shape}\u0000${JSON.stringify(q.bindings)}`;
    const id = identical.get(key) || { sql: q.sql, bindings: q.bindings, count: 0, totalMs: 0 };
    id.count++; id.totalMs = round(id.totalMs + (q.durationMs || 0));
    identical.set(key, id);
    const sh = shapes.get(shape) || { sql: q.sql, count: 0, totalMs: 0 };
    sh.count++; sh.totalMs = round(sh.totalMs + (q.durationMs || 0));
    shapes.set(shape, sh);
  }
  const duplicates = [...identical.values()].filter((d) => d.count > 1).sort((a, b) => b.count - a.count);
  const repeated = [...shapes.values()].filter((s) => s.count >= DEBUG_LIMITS.repeatedQuery).sort((a, b) => b.count - a.count);
  const slow = queries.filter((q) => (q.durationMs || 0) >= DEBUG_LIMITS.slowQueryMs).length;
  return { duplicates, repeated, slow };
}

export class DebugCollector {
  #buckets = new Map();
  #installed = false;
  #enabled = false;
  #pending = new Map();
  #pendingCount = 0;
  #capturing = false;
  #resolveUser = null;
  #removeProbe = null;
  #originalConsole = null;
  #onUncaught = null;
  /** Errors seen failing a query → their bindings-free message. */
  #queryErrors = new WeakMap();
  #stream = null;
  #outbox = new Map();   // tenant → { requests: [], logs: [], errors: [] }
  #flushTimer = null;

  /** Requests to these documents are not recorded (the debugger watching itself). */
  ignoreDocuments = new Set(['debugger']);

  get enabled() { return this.#enabled; }
  get installed() { return this.#installed; }

  /**
   * @param {object}   opts
   * @param {boolean}  [opts.enabled]        defaults to config/core.json → debug
   * @param {Function} [opts.addQueryProbe]  db-env's addQueryProbe
   * @param {Function} [opts.resolveUser]    () => user name, run inside the request's context
   * @param {boolean}  [opts.console=true]   capture console.*
   */
  install({ enabled = debugEnabled(), addQueryProbe = null, resolveUser = null, console: captureConsole = true, stream = null } = {}) {
    if (this.#installed) return this;
    this.#installed = true;
    this.#enabled = !!enabled;
    this.#resolveUser = resolveUser;
    this.#stream = stream && typeof stream.publish === 'function' ? stream : null;
    if (!this.#enabled) return this;

    if (addQueryProbe) {
      this.#removeProbe = addQueryProbe({
        onQuery: (q) => this.#onQuery(q),
        onResponse: (r, q) => this.#settle(q, { rows: rowCount(r) }),
        onError: (e, q) => {
          const message = driverMessage(e);
          if (e && typeof e === 'object') this.#queryErrors.set(e, message);
          this.#settle(q, { error: clip(scrubText(message), 1000) });
        },
      });
    }
    if (captureConsole) this.#wrapConsole();

    this.#onUncaught = (err, origin) => this.recordError(err, { source: origin || 'uncaughtException', status: 500 });
    process.on('uncaughtExceptionMonitor', this.#onUncaught);
    return this;
  }

  /** Undo install() (tests). */
  uninstall() {
    this.#removeProbe?.();
    this.#removeProbe = null;
    if (this.#originalConsole) {
      for (const level of LEVELS) console[level] = this.#originalConsole[level];
      this.#originalConsole = null;
    }
    if (this.#onUncaught) process.off('uncaughtExceptionMonitor', this.#onUncaught);
    this.#onUncaught = null;
    if (this.#flushTimer) clearTimeout(this.#flushTimer);
    this.#flushTimer = null;
    this.#outbox.clear();
    this.#stream = null;
    this.#installed = false;
    this.#enabled = false;
    this.#buckets.clear();
    this.#pending.clear();
    this.#pendingCount = 0;
  }

  // ─── Buckets ──────────────────────────────────────────────────────────────

  #bucket(tenant) {
    const name = tenant || CORE_BUCKET;
    let b = this.#buckets.get(name);
    if (!b) {
      b = {
        requests: new Ring(DEBUG_LIMITS.requests),
        logs: new Ring(DEBUG_LIMITS.logs),
        errors: new Ring(DEBUG_LIMITS.errors),
        background: new Ring(DEBUG_LIMITS.background),
        since: new Date().toISOString(),
      };
      this.#buckets.set(name, b);
    }
    return b;
  }

  // ─── Live stream ──────────────────────────────────────────────────────────

  #wants(tenant) {
    if (!this.#stream || !tenant || tenant === CORE_BUCKET) return false;
    try { return this.#stream.wants ? !!this.#stream.wants(tenant) : true; } catch { return false; }
  }

  #enqueue(tenant, kind, item) {
    if (!this.#wants(tenant)) return;
    let box = this.#outbox.get(tenant);
    if (!box) this.#outbox.set(tenant, (box = { requests: [], logs: [], errors: [] }));
    if (box[kind].length < 200) box[kind].push(typeof item === 'function' ? item() : item);
    this.#flushTimer ??= setTimeout(() => this.#flush(), STREAM_MS);
  }

  #flush() {
    this.#flushTimer = null;
    const boxes = [...this.#outbox.entries()];
    this.#outbox.clear();
    // Anything the transport logs while publishing is not news to stream.
    this.#capturing = true;
    try {
      for (const [tenant, box] of boxes) {
        for (const kind of ['requests', 'logs', 'errors']) {
          if (box[kind].length) this.#stream.publish(tenant, kind, { rows: box[kind] });
        }
      }
    } catch { /* a closed socket never breaks the collector */ }
    finally { this.#capturing = false; }
  }

  #context() {
    const store = requestContext.getStore();
    return { store, entry: store?.req?.__DEBUG__ ?? null, tenant: store?.tenant?.name ?? null };
  }

  // ─── Requests ─────────────────────────────────────────────────────────────

  /** Express middleware; mount right after tenant resolution (inside the ALS store). */
  middleware() {
    return (req, res, next) => {
      if (!this.#enabled) return next();
      const store = requestContext.getStore();
      const tenant = store?.tenant?.name;
      if (!tenant) return next();

      const entry = {
        id: newId(),
        tenant,
        at: new Date().toISOString(),
        t0: nowMs(),
        method: req.method,
        url: clip(redactUrl(req.originalUrl || req.url), 1000),
        ip: req.ip || null,
        headers: pickHeaders(req.headers),
        status: null,
        durationMs: null,
        user: null,
        route: null,
        queries: [],
        logs: [],
        errors: [],
        queryMs: 0,
        droppedQueries: 0,
        droppedLogs: 0,
        finished: false,
      };
      req.__DEBUG__ = entry;
      res.setHeader('X-Loopar-Debug', entry.id);

      res.on('finish', () => this.#finish(entry, req, res, store, false));
      res.on('close', () => this.#finish(entry, req, res, store, true));
      next();
    };
  }

  #finish(entry, req, res, store, closed) {
    if (entry.finished) return;
    entry.finished = true;
    entry.durationMs = round(nowMs() - entry.t0);
    entry.status = closed && !res.writableFinished ? 499 : res.statusCode;

    const params = req.__params__;
    // Never reached the router: Vite modules, static files, asset 404s.
    if (!params || req.isAssetUrl) return;
    const document = params.document ?? null;
    if (document && this.ignoreDocuments.has(lower(document))) return;

    entry.route = {
      mode: req.__ROUTE_MODE__ ?? null,
      workspace: req.__WORKSPACE_NAME__ ?? null,
      document,
      action: req.__CONTROLLER__?.action ?? params.action ?? null,
      name: params.name ?? null,
    };
    entry.ajax = !!req.__IS_AJAX__;
    const body = req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? req.body : {};
    entry.params = { query: redactObject(req.query || {}), body: redactObject(body) };
    entry.response = {
      type: clip(res.getHeader('content-type') ?? '', 120) || null,
      size: Number(res.getHeader('content-length')) || null,
    };
    entry.user = this.#userOf(req, store);
    this.#bucket(entry.tenant).requests.push(entry);
    this.#enqueue(entry.tenant, 'requests', () => this.#summary(entry));
  }

  #userOf(req, store) {
    if (req.__authUserName__ !== undefined) return req.__authUserName__ ?? null;
    if (!this.#resolveUser || !store) return null;
    try {
      return requestContext.run(store, () => this.#resolveUser()) ?? null;
    } catch {
      return null;
    }
  }

  // ─── Queries ──────────────────────────────────────────────────────────────

  #onQuery(q) {
    if (!this.#enabled || !q?.sql) return;
    const { entry, tenant } = this.#context();
    if (this.#pendingCount >= DEBUG_LIMITS.pending) { this.#pending.clear(); this.#pendingCount = 0; }
    const key = q.__knexQueryUid || q.sql;
    const list = this.#pending.get(key);
    const rec = { t: nowMs(), entry, tenant, sql: q.sql, bindings: q.bindings, method: q.method ?? null, tx: !!q.__knexTxId };
    if (list) list.push(rec); else this.#pending.set(key, [rec]);
    this.#pendingCount++;
  }

  #settle(q, extra) {
    if (!q?.sql) return;
    const key = q.__knexQueryUid || q.sql;
    const list = this.#pending.get(key);
    const rec = list?.shift();
    if (!rec) return;
    if (!list.length) this.#pending.delete(key);
    this.#pendingCount = Math.max(0, this.#pendingCount - 1);

    const end = nowMs();
    const query = {
      sql: clip(rec.sql, DEBUG_LIMITS.sqlChars),
      bindings: redactBindings(rec.sql, rec.bindings),
      method: rec.method,
      durationMs: round(end - rec.t),
      rows: extra.rows ?? null,
      error: extra.error ?? null,
      tx: rec.tx,
    };

    const entry = rec.entry;
    if (entry) {
      query.offsetMs = round(rec.t - entry.t0);
      if (entry.finished) query.late = true; // after-hooks fired once the response was sent
      entry.queryMs = round(entry.queryMs + query.durationMs);
      if (entry.queries.length < DEBUG_LIMITS.queriesPerRequest) entry.queries.push(query);
      else entry.droppedQueries++;
      return;
    }
    this.#bucket(rec.tenant).background.push({ ...query, at: new Date().toISOString() });
  }

  // ─── Logs ─────────────────────────────────────────────────────────────────

  #wrapConsole() {
    this.#originalConsole = {};
    for (const level of LEVELS) {
      const original = console[level];
      this.#originalConsole[level] = original;
      const collector = this;
      console[level] = function debugCapture(...args) {
        original.apply(console, args);
        collector.recordLog(level, args);
      };
    }
  }

  /** Record one console call (also usable directly: recordLog('info', ['text'])). */
  recordLog(level, args) {
    if (!this.#enabled || this.#capturing) return;
    this.#capturing = true;
    try {
      const { entry, tenant } = this.#context();
      const text = clip(scrubText(util.format(...args).replace(ANSI, '')), DEBUG_LIMITS.logChars);
      const rec = { at: new Date().toISOString(), level, text, requestId: entry?.id ?? null };
      this.#bucket(tenant).logs.push(rec);
      this.#enqueue(tenant, 'logs', rec);
      if (entry) {
        if (entry.logs.length < DEBUG_LIMITS.logsPerRequest) entry.logs.push(rec);
        else entry.droppedLogs++;
      }
    } catch {
      // a log line that can't be formatted is not worth breaking the caller
    } finally {
      this.#capturing = false;
    }
  }

  // ─── Errors ───────────────────────────────────────────────────────────────

  /**
   * @param {*} err
   * @param {object} [opts]
   * @param {object} [opts.req]     defaults to the request in context
   * @param {number} [opts.status]  normalized HTTP status (error middleware)
   * @param {string} [opts.source]  'request' | 'uncaughtException' | …
   */
  recordError(err, opts = {}) {
    if (!this.#enabled) return null;
    try {
      return this.#recordError(err, opts);
    } catch {
      return null; // whatever was thrown, recording it never breaks error handling
    }
  }

  #recordError(err, { req, status, source = 'request' } = {}) {
    const ctx = this.#context();
    req ??= ctx.store?.req;
    const entry = req?.__DEBUG__ ?? null;
    const code = Number(status ?? err?.status ?? (typeof err?.code === 'number' ? err.code : NaN));
    const httpStatus = Number.isFinite(code) && code >= 100 && code <= 599 ? code : 500;

    // A query failure carries its SQL with the values interpolated in the
    // message (and so in the first line of the stack): use the driver's part.
    const fullMessage = String(err?.message ?? err);
    const message = this.#queryErrors.get(err) ?? fullMessage;
    let stack = err?.stack ? String(err.stack) : null;
    if (stack && message !== fullMessage) stack = stack.split(fullMessage).join(message);

    const rec = {
      id: newId(),
      at: new Date().toISOString(),
      source,
      status: httpStatus,
      level: httpStatus >= 500 ? 'error' : 'warning',
      name: err?.name ?? (typeof err),
      title: err?.title ? clip(err.title, 200) : null,
      text: clip(scrubText(message), 2000),
      code: typeof err?.code === 'string' ? clip(err.code, 80) : null,
      stack: stack ? clip(scrubText(stack.replace(ANSI, '')), DEBUG_LIMITS.stackChars) : null,
      method: req?.method ?? null,
      url: req ? clip(redactUrl(req.originalUrl || req.url), 1000) : null,
      requestId: entry?.id ?? null,
    };
    this.#bucket(entry?.tenant ?? ctx.tenant).errors.push(rec);
    if (entry && entry.errors.length < DEBUG_LIMITS.errorsPerRequest) entry.errors.push(rec);
    this.#enqueue(entry?.tenant ?? ctx.tenant, 'errors', rec);
    return rec;
  }

  // ─── Reading ──────────────────────────────────────────────────────────────

  #summary(entry) {
    const a = analyse(entry.queries);
    return {
      id: entry.id,
      at: entry.at,
      method: entry.method,
      url: entry.url,
      status: entry.status,
      durationMs: entry.durationMs,
      user: entry.user,
      workspace: entry.route?.workspace ?? null,
      document: entry.route?.document ?? null,
      action: entry.route?.action ?? null,
      ajax: !!entry.ajax,
      queryCount: entry.queries.length + entry.droppedQueries,
      queryMs: entry.queryMs,
      slowQueries: a.slow,
      duplicateQueries: a.duplicates.reduce((n, d) => n + d.count - 1, 0),
      repeatedQueries: a.repeated.length,
      logCount: entry.logs.length + entry.droppedLogs,
      errorCount: entry.errors.length,
    };
  }

  /**
   * Request summaries, newest first.
   * filter: { limit, offset, status ('2xx'|'4xx'|'5xx'|'error'|404), method,
   *           document, action, user, minMs, q (url contains), since, ajax }
   */
  requests(tenant, filter = {}) {
    const limit = clampInt(filter.limit, 50, 1, 500);
    const offset = clampInt(filter.offset, 0, 0, 100000);
    const since = toTime(filter.since);
    const minMs = Number(filter.minMs) || 0;
    const q = filter.q ? lower(filter.q) : null;
    const rows = this.#bucket(tenant).requests.newest().filter((e) =>
      matchesStatus(e.status, filter.status) &&
      (!filter.method || lower(e.method) === lower(filter.method)) &&
      (!filter.document || lower(e.route?.document) === lower(filter.document)) &&
      (!filter.action || lower(e.route?.action) === lower(filter.action)) &&
      (!filter.user || e.user === filter.user) &&
      (filter.ajax === undefined || filter.ajax === '' || !!e.ajax === (filter.ajax === true || filter.ajax === 'true' || filter.ajax === 1)) &&
      (!minMs || (e.durationMs || 0) >= minMs) &&
      (!q || lower(e.url).includes(q)) &&
      (since === null || Date.parse(e.at) > since)
    );
    return { total: rows.length, rows: rows.slice(offset, offset + limit).map((e) => this.#summary(e)) };
  }

  /** One request, everything recorded about it. */
  request(tenant, id) {
    const entry = this.#bucket(tenant).requests.items.find((e) => e.id === id);
    if (!entry) return null;
    const summary = this.#summary(entry);
    const a = analyse(entry.queries);
    return {
      ...summary,
      tenant: entry.tenant,
      ip: entry.ip,
      route: entry.route,
      headers: entry.headers,
      params: entry.params,
      response: entry.response,
      queries: entry.queries,
      droppedQueries: entry.droppedQueries,
      logs: entry.logs,
      droppedLogs: entry.droppedLogs,
      errors: entry.errors,
      analysis: { duplicates: a.duplicates, repeated: a.repeated, slowThresholdMs: DEBUG_LIMITS.slowQueryMs },
    };
  }

  /** The most recent request (optionally of one user / matching a filter). */
  latest(tenant, filter = {}) {
    const [row] = this.requests(tenant, { ...filter, limit: 1 }).rows;
    return row ? this.request(tenant, row.id) : null;
  }

  /** SQL across the buffered requests: statements by total time, slowest runs, background queries. */
  queries(tenant, { limit = 50 } = {}) {
    const max = clampInt(limit, 50, 1, 500);
    const b = this.#bucket(tenant);
    const shapes = new Map();
    const runs = [];
    for (const e of b.requests.items) {
      for (const q of e.queries) {
        const shape = shapeOf(q.sql);
        const s = shapes.get(shape) || { sql: q.sql, count: 0, totalMs: 0, maxMs: 0, errors: 0, requests: new Set(), lastAt: e.at };
        s.count++;
        s.totalMs = round(s.totalMs + (q.durationMs || 0));
        s.maxMs = Math.max(s.maxMs, q.durationMs || 0);
        if (q.error) s.errors++;
        s.requests.add(e.id);
        if (e.at > s.lastAt) s.lastAt = e.at;
        shapes.set(shape, s);
        runs.push({ ...q, requestId: e.id, url: e.url, at: e.at });
      }
    }
    const statements = [...shapes.values()]
      .map((s) => ({ ...s, requests: s.requests.size, avgMs: round(s.totalMs / s.count) }))
      .sort((x, y) => y.totalMs - x.totalMs)
      .slice(0, max);
    const slowest = runs.sort((x, y) => (y.durationMs || 0) - (x.durationMs || 0)).slice(0, max);
    const failed = runs.filter((r) => r.error).slice(0, max);
    return { statements, slowest, failed, background: b.background.newest().slice(0, max) };
  }

  /** filter: { level, q, since, requestId, limit, offset } */
  logs(tenant, filter = {}) {
    const limit = clampInt(filter.limit, 200, 1, 2000);
    const offset = clampInt(filter.offset, 0, 0, 100000);
    const since = toTime(filter.since);
    const levels = filter.level ? new Set(String(filter.level).split(',').map(lower)) : null;
    const q = filter.q ? lower(filter.q) : null;
    const rows = this.#bucket(tenant).logs.newest().filter((l) =>
      (!levels || levels.has(l.level)) &&
      (!filter.requestId || l.requestId === filter.requestId) &&
      (!q || lower(l.text).includes(q)) &&
      (since === null || Date.parse(l.at) > since)
    );
    return { total: rows.length, rows: rows.slice(offset, offset + limit) };
  }

  /** filter: { level ('error'|'warning'), since, limit, offset } */
  errors(tenant, filter = {}) {
    const limit = clampInt(filter.limit, 100, 1, 1000);
    const offset = clampInt(filter.offset, 0, 0, 100000);
    const since = toTime(filter.since);
    const rows = this.#bucket(tenant).errors.newest().filter((e) =>
      (!filter.level || e.level === lower(filter.level)) &&
      (since === null || Date.parse(e.at) > since)
    );
    return { total: rows.length, rows: rows.slice(offset, offset + limit) };
  }

  stats(tenant) {
    const b = this.#bucket(tenant);
    const reqs = b.requests.items;
    const errors = b.errors.items;
    return {
      enabled: this.#enabled,
      since: b.since,
      requests: reqs.length,
      logs: b.logs.size,
      errors: errors.filter((e) => e.level === 'error').length,
      warnings: errors.filter((e) => e.level === 'warning').length,
      backgroundQueries: b.background.size,
      oldestRequestAt: reqs[0]?.at ?? null,
      limits: DEBUG_LIMITS,
    };
  }

  clear(tenant) {
    this.#buckets.delete(tenant || CORE_BUCKET);
  }
}

export const debugCollector = new DebugCollector();
