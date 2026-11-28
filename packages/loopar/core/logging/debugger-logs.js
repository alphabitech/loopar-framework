'use strict';

/**
 * The desk Debugger's Logs — read from the core's log files (the same source
 * and parser as the terminal Tenant Manager), so both always show the same
 * lines. Live lines come from the console prefixer (onTenantLog), i.e. what
 * is being written to those files at that moment.
 *
 * Isolation: a tenant only gets lines stamped with its own name; core-level
 * lines and other tenants' never leave. Text and stacks go through the
 * Debugger's secret scrubbing.
 */

import { tenantRegistry } from '../server/tenant-registry.js';
import { scrubText, clip } from '../debug/redact.js';
import { lineState, readTail, readStreams, groupLines, coreLogFiles, levelOf, CONTINUATION_RE } from './tenant-log.js';

const TAIL_BYTES = 1024 * 1024; // a tenant's lines are a fraction of the files
const TEXT_CHARS = 4000;
const STACK_CHARS = 16000;

/** { at, s, text, stack[] } → the Debugger's log row (newest-first lists, LogLine). */
export function debuggerRow({ at, s, text, stack = [] }) {
  const row = {
    at: new Date(at ?? Date.now()).toISOString(),
    level: levelOf(s, text),
    text: clip(scrubText(text), TEXT_CHARS),
    stream: s,
  };
  if (stack.length) row.stack = clip(scrubText(stack.join('\n')), STACK_CHARS);
  return row;
}

/** A live message (possibly multi-line) → its rows, grouped like the files' lines. */
export function debuggerRowsOf({ at, s, text }) {
  const lines = String(text).split('\n').map((line) => ({ at, s, text: line, cont: CONTINUATION_RE.test(line) && line !== '' }));
  return groupLines(lines).map(debuggerRow);
}

/**
 * filter: { level ('error,warn,log'), q, since, limit, offset } — same
 * contract the in-memory logs had. Rows newest first.
 */
export function tenantLogs(tenant, filter = {}) {
  const files = coreLogFiles();
  if (!files.out && !files.err) return { total: 0, rows: [], source: null };

  const st = lineState({ known: tenantRegistry.all().map((t) => t.name), tenant });
  const r = readStreams(st, {
    out: (files.out && readTail(files.out, TAIL_BYTES)) || [],
    err: (files.err && readTail(files.err, TAIL_BYTES)) || [],
  });
  // Continuations group within their own stream, then both streams interleave.
  let rows = [...groupLines(r.out), ...groupLines(r.err)];
  if (r.timed) rows.sort((a, b) => a.at - b.at);
  rows = rows.map(debuggerRow).reverse();

  const levels = filter.level ? new Set(String(filter.level).split(',').map((l) => l.trim().toLowerCase())) : null;
  const q = filter.q ? String(filter.q).toLowerCase() : null;
  const since = filter.since ? Date.parse(filter.since) : null;
  const matched = rows.filter((l) =>
    (!levels || levels.has(l.level)) &&
    (!q || l.text.toLowerCase().includes(q) || l.stack?.toLowerCase().includes(q)) &&
    (since === null || Number.isNaN(since) || Date.parse(l.at) > since)
  );
  const limit = Math.min(Math.max(1, Number(filter.limit) || 200), 2000);
  const offset = Math.max(0, Number(filter.offset) || 0);
  return { total: matched.length, rows: matched.slice(offset, offset + limit), source: 'files' };
}
