'use strict';

import {
  PageController,
  loopar,
  debugCollector,
  frameworkStatus,
  testRuns,
  listTestFiles,
  testsAllowed,
  TEST_SUITES,
} from 'loopar';
import { bearerFrom, verifyToken, createToken, listTokens, revokeToken } from '../../debug-tokens.js';
import { apiManifest } from '../../api-manifest.js';

/**
 * Debugger — desk page + JSON API over core/debug.
 *
 * Two ways in:
 *   - desk session (cookie + CSRF): the regular permission check — the
 *     Administrator, or roles granted "Debugger" actions.
 *   - `Authorization: Bearer ldbg_…` on /api/Debugger/<action>: a debug token
 *     (see debug-tokens.js), accepted ONLY for the actions in TOKEN_ACTIONS
 *     and only here. The token never stands in for a user anywhere else.
 *
 * Every payload is wrapped under a named key (`request`, `run`, `rows`…):
 * top-level `status`/`code`/`message` are reserved by the response envelope.
 */

// Lowercased action → scope a token needs.
const TOKEN_ACTIONS = {
  manifest: 'read', status: 'read', requests: 'read', request: 'read', latest: 'read',
  queries: 'read', logs: 'read', errors: 'read',
  testfiles: 'read', testrun: 'read', testruns: 'read',
  runtests: 'run', canceltests: 'run',
};

const MAX_WAIT_SECONDS = 600;

/** Every publicAction<X> a class inherits (PageController ships reviews, galleries, forms…). */
function inheritedPublicActions(cls) {
  const names = new Set();
  for (let proto = cls.prototype; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (key.startsWith('publicAction') && key.length > 12) names.add(key.slice(12));
    }
  }
  return [...names];
}

export default class DebuggerController extends PageController {
  defaultAction = 'view';
  static postOnlyActions = ['runTests', 'cancelTests', 'clear', 'createToken', 'revokeToken'];

  // The debugger has no public surface: withdraw every public action the
  // page controller inherits (they would answer without a session).
  static get revokedPublicActions() {
    return inheritedPublicActions(this);
  }

  #token = null;

  constructor(props) {
    super(props);
  }

  /** Query string + body (loopar.call sends `query` as query params). */
  get input() {
    return { ...(this.query || {}), ...(this.data || {}) };
  }

  get tenant() {
    return loopar.requestTenantId;
  }

  /** Who asked: the desk user or the token's label. */
  get requester() {
    return this.#token ? `token:${this.#token.label}` : (loopar.auth?.user?.() ?? null);
  }

  async beforeAction() {
    const bearer = bearerFrom(this.req);
    if (bearer === null) return await super.beforeAction();

    const action = String(this.action || '');
    const scope = TOKEN_ACTIONS[action.toLowerCase()];
    if (this.req?.__ROUTE_MODE__ !== 'rpc' || !scope) {
      loopar.throw({ code: 403, title: 'Forbidden', message: `"${action}" is not available with a debug token.` });
    }
    const mutating = this.constructor.postOnlyActions.some((a) => a.toLowerCase() === action.toLowerCase());
    if (mutating && String(this.method || '').toUpperCase() !== 'POST') {
      loopar.throw({ code: 405, title: 'Method Not Allowed', message: `"${action}" must be called with POST.` });
    }

    this.#token = await verifyToken(bearer, { ip: this.req?.ip });
    if (scope === 'run' && this.#token.scope !== 'run') {
      loopar.throw({ code: 403, title: 'Forbidden', message: 'This token has the "read" scope; test runs need "run".' });
    }
    return true;
  }

  // ─── Page ────────────────────────────────────────────────────────────────

  async actionView() {
    const view = await loopar.newDocument('Debugger');
    return await this.render(view);
  }

  /** Desk top-bar chip: the current user's latest requests + new errors. */
  async actionToolbar() {
    const user = loopar.auth?.user?.() ?? null;
    if (!debugCollector.enabled) return { enabled: false };
    return {
      enabled: true,
      user,
      recent: debugCollector.requests(this.tenant, { user, limit: 8 }).rows,
      errors: debugCollector.errors(this.tenant, { level: 'error', since: this.input.since }).total,
    };
  }

  // ─── Read API (session or token) ─────────────────────────────────────────

  async actionManifest() {
    return { api: apiManifest() };
  }

  async actionStatus() {
    // Not `status`: the response envelope owns that key (HTTP status).
    return { info: await frameworkStatus() };
  }

  async actionRequests() {
    return { enabled: debugCollector.enabled, ...debugCollector.requests(this.tenant, this.input) };
  }

  async actionRequest() {
    const id = String(this.input.id || '');
    const request = id ? debugCollector.request(this.tenant, id) : null;
    if (!request) loopar.throw({ code: 404, title: 'Not found', message: `No recorded request "${id}" (the buffer keeps the latest ones only).` });
    return { request };
  }

  async actionLatest() {
    const { id, ...filter } = this.input;
    return { request: debugCollector.latest(this.tenant, filter) };
  }

  async actionQueries() {
    return { queries: debugCollector.queries(this.tenant, this.input) };
  }

  async actionLogs() {
    return debugCollector.logs(this.tenant, this.input);
  }

  async actionErrors() {
    return debugCollector.errors(this.tenant, this.input);
  }

  async actionClear() {
    debugCollector.clear(this.tenant);
    return { cleared: true };
  }

  // ─── Tests ───────────────────────────────────────────────────────────────

  async actionTestFiles() {
    return {
      files: listTestFiles(),
      suites: Object.keys(TEST_SUITES),
      allowed: testsAllowed(),
      active: testRuns.activeFor(this.tenant)?.id ?? null,
    };
  }

  #filesInput(raw) {
    if (raw === undefined || raw === null || raw === '') return [];
    if (Array.isArray(raw)) return raw.map(String);
    if (typeof raw === 'string' && raw.trim().startsWith('[')) {
      try { return JSON.parse(raw).map(String); } catch { /* fall through */ }
    }
    return String(raw).split(',').map((f) => f.trim()).filter(Boolean);
  }

  async actionRunTests() {
    const input = this.input;
    let handle;
    try {
      handle = testRuns.start(
        {
          files: this.#filesInput(input.files),
          suite: input.suite || 'all',
          namePattern: input.namePattern ? String(input.namePattern) : null,
        },
        { requestedBy: this.requester, tenant: this.tenant },
      );
    } catch (err) {
      loopar.throw({ code: err.status || 400, title: 'Tests', message: err.message });
    }

    const wait = Math.min(Math.max(Number(input.wait) || 0, 0), MAX_WAIT_SECONDS);
    if (wait > 0) {
      await Promise.race([handle.promise, new Promise((r) => setTimeout(r, wait * 1000))]);
    }
    return { run: { ...handle.state(), meta: handle.meta } };
  }

  async actionTestRun() {
    const handle = testRuns.get(this.input.id ? String(this.input.id) : null, this.tenant);
    if (!handle) loopar.throw({ code: 404, title: 'Not found', message: 'No such test run.' });
    const brief = this.input.brief === true || this.input.brief === 'true' || this.input.brief === 1;
    return { run: { ...handle.state({ brief }), meta: handle.meta } };
  }

  async actionTestRuns() {
    return { runs: testRuns.list(this.tenant) };
  }

  async actionCancelTests() {
    return { cancelled: testRuns.cancel(this.input.id ? String(this.input.id) : null, this.tenant) };
  }

  // ─── API tokens (desk session only) ──────────────────────────────────────

  async actionTokens() {
    return { tokens: await listTokens() };
  }

  async actionCreateToken() {
    const { label, scope, days } = this.input;
    return await createToken({ label, scope: scope || 'read', days: days === undefined || days === '' ? 30 : Number(days) });
  }

  async actionRevokeToken() {
    await revokeToken(this.input.name);
    return { revoked: true };
  }
}
