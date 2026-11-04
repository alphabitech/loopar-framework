'use strict';

/**
 * node:test reporter that writes one JSON object per line (NDJSON) — the
 * machine-readable form test-runner.js parses for the TUI, the Debugger and
 * agents. Used as `node --test --test-reporter=<this file>`.
 *
 * Line shapes:
 *   { type: 'start' | 'pass' | 'fail', name, file, line, nesting, kind, durationMs, skip, todo, error }
 *   { type: 'diagnostic', file, nesting, text }
 *   { type: 'stdout' | 'stderr', file, text }
 *   { type: 'coverage', ... } is not emitted (coverage is not enabled).
 *
 * `error` (fail only): { failureType, name, message, code, operator, actual, expected, stack }.
 */

import { inspect } from 'node:util';

const MAX = 6000;
const clip = (s, max = MAX) => {
  if (s === undefined || s === null) return null;
  const text = String(s);
  return text.length > max ? `${text.slice(0, max)}…(+${text.length - max} chars)` : text;
};

function serializeError(err) {
  if (!err) return null;
  const cause = err.code === 'ERR_TEST_FAILURE' && err.cause ? err.cause : err;
  const out = {
    failureType: err.failureType ?? null,
    name: cause?.name ?? null,
    message: clip(cause?.message ?? (typeof cause === 'string' ? cause : inspect(cause, { depth: 2 })), 4000),
    code: typeof cause?.code === 'string' ? cause.code : null,
    operator: cause?.operator ?? null,
    stack: clip(cause?.stack),
  };
  if (cause && typeof cause === 'object' && ('actual' in cause || 'expected' in cause)) {
    out.actual = clip(inspect(cause.actual, { depth: 4, breakLength: 100 }), 3000);
    out.expected = clip(inspect(cause.expected, { depth: 4, breakLength: 100 }), 3000);
  }
  return out;
}

function testEvent(type, data) {
  return {
    type,
    name: data.name ?? null,
    file: data.file ?? null,
    line: data.line ?? null,
    nesting: data.nesting ?? 0,
    kind: data.details?.type ?? null, // 'test' | 'suite'
    durationMs: data.details?.duration_ms ?? null,
    skip: data.skip === undefined ? false : (data.skip === true ? true : clip(data.skip, 300)),
    todo: data.todo === undefined ? false : (data.todo === true ? true : clip(data.todo, 300)),
    error: type === 'fail' ? serializeError(data.details?.error) : undefined,
  };
}

export default async function* ndjsonReporter(source) {
  for await (const event of source) {
    const { type, data = {} } = event;
    let out = null;
    switch (type) {
      case 'test:start': out = { type: 'start', name: data.name, file: data.file ?? null, line: data.line ?? null, nesting: data.nesting ?? 0 }; break;
      case 'test:pass': out = testEvent('pass', data); break;
      case 'test:fail': out = testEvent('fail', data); break;
      case 'test:diagnostic': out = { type: 'diagnostic', file: data.file ?? null, nesting: data.nesting ?? 0, text: clip(data.message, 2000) }; break;
      case 'test:stdout': out = { type: 'stdout', file: data.file ?? null, text: clip(data.message, 4000) }; break;
      case 'test:stderr': out = { type: 'stderr', file: data.file ?? null, text: clip(data.message, 4000) }; break;
      default: break;
    }
    if (out) yield `${JSON.stringify(out)}\n`;
  }
}
