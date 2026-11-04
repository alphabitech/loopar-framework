'use strict';

/**
 * Machine-readable description of the Debugger API, served by
 * GET /api/Debugger/manifest — the entry point for an agent: what it can
 * call, with which scope, and what comes back.
 */

const P = (type, description, extra = {}) => ({ type, description, ...extra });

export const DEBUGGER_ENDPOINTS = [
  { action: 'manifest', method: 'GET', scope: 'read', description: 'This document.' },
  { action: 'status', method: 'GET', scope: 'read', description: 'Framework and tenant status: versions, mode, build, memory, DB, installed apps (updatePending), collector stats.', returns: '{ info: { framework, tenant, apps, backup: { count, last, lastScheduled }, collector } }' },
  {
    action: 'requests', method: 'GET', scope: 'read', description: 'Recorded requests, newest first (summaries).',
    params: {
      limit: P('number', '1–500, default 50'), offset: P('number', 'default 0'),
      status: P('string', "'2xx' | '3xx' | '4xx' | '5xx' | 'error' | an exact code"),
      method: P('string', 'GET, POST…'), document: P('string', 'Entity/page name'), action: P('string', 'Controller action'),
      user: P('string', 'User name'), minMs: P('number', 'Only requests at least this slow'),
      q: P('string', 'URL contains'), since: P('string|number', 'ISO date or epoch ms: only newer'), ajax: P('boolean', 'Only AJAX/RPC (true) or page loads (false)'),
    },
    returns: '{ enabled, total, rows: [{ id, at, method, url, status, durationMs, user, document, action, queryCount, queryMs, slowQueries, duplicateQueries, repeatedQueries, logCount, errorCount }] }',
  },
  { action: 'request', method: 'GET', scope: 'read', description: 'Everything recorded for one request: route, params (redacted), headers, every SQL statement with timing and bindings (redacted), logs, errors and an analysis (duplicate / repeated (N+1) queries).', params: { id: P('string', 'Request id (also sent as the X-Loopar-Debug response header)', { required: true }) }, returns: '{ request }' },
  { action: 'latest', method: 'GET', scope: 'read', description: 'The most recent request matching the same filters as `requests`, in full.', returns: '{ request }' },
  { action: 'queries', method: 'GET', scope: 'read', description: 'SQL across the buffered requests: statements by total time, slowest runs, failed queries and background (out-of-request) queries.', params: { limit: P('number', '1–500, default 50') }, returns: '{ queries: { statements, slowest, failed, background } }' },
  { action: 'logs', method: 'GET', scope: 'read', description: 'console output of this tenant, newest first.', params: { level: P('string', "comma list of log, info, warn, error, debug"), q: P('string', 'text contains'), requestId: P('string', 'Only lines logged by this request'), since: P('string|number', 'ISO or epoch ms'), limit: P('number', '1–2000, default 200'), offset: P('number', '') }, returns: '{ total, rows: [{ at, level, text, requestId }] }' },
  { action: 'errors', method: 'GET', scope: 'read', description: 'Errors raised while serving this tenant (5xx = error, 4xx = warning), newest first, with stack.', params: { level: P('string', "'error' | 'warning'"), since: P('string|number', 'ISO or epoch ms'), limit: P('number', '1–1000, default 100'), offset: P('number', '') }, returns: '{ total, rows: [{ id, at, status, level, name, text, stack, method, url, requestId }] }' },
  { action: 'testFiles', method: 'GET', scope: 'read', description: 'Test files of the repo and whether runs are allowed (development only).', returns: '{ files: [{ file, suite }], suites, allowed, active }' },
  { action: 'runTests', method: 'POST', scope: 'run', description: 'Start a test run (one at a time). With `wait`, the response holds until it finishes (or `wait` seconds pass).', params: { suite: P('string', "'all' (default) | 'unit' | 'integration'"), files: P('string[]', 'Subset of testFiles (overrides suite)'), namePattern: P('string', 'node --test-name-pattern'), wait: P('number', 'Seconds to wait for the result, 0–600') }, returns: '{ run: { id, status, counts, files, failures: [{ name, path, file, line, error: { message, actual, expected, stack } }], tests, output } }' },
  { action: 'testRun', method: 'GET', scope: 'read', description: 'A run by id (default: the active or latest one).', params: { id: P('string', 'Run id'), brief: P('boolean', 'Omit the per-test list and output') }, returns: '{ run }' },
  { action: 'testRuns', method: 'GET', scope: 'read', description: 'Active and recent runs (brief).', returns: '{ runs }' },
  { action: 'cancelTests', method: 'POST', scope: 'run', description: 'Cancel a run (default: the active one).', params: { id: P('string', 'Run id') }, returns: '{ cancelled }' },
];

export function apiManifest() {
  return {
    name: 'Loopar Debugger API',
    base: '/api/Debugger',
    auth: {
      header: 'Authorization: Bearer ldbg_<id>_<secret>',
      howToGetOne: 'Desk → Debugger → API access → New token (shown once). A desk session (cookie + CSRF) works too.',
      scopes: { read: 'Every GET endpoint.', run: 'read + runTests / cancelTests.' },
    },
    tenant: 'The API answers for the tenant of the host it is called on; data of other tenants is never visible.',
    correlation: 'Every response of this tenant carries `X-Loopar-Debug: <requestId>`: call any endpoint, then read GET /api/Debugger/request?id=<requestId> to see its SQL, logs and errors.',
    redaction: 'Passwords, tokens, secrets, cookies and similar values are replaced by "[redacted]" before being stored.',
    responses: 'JSON. Errors: { status, success: false, code, title, message }.',
    endpoints: DEBUGGER_ENDPOINTS,
  };
}
