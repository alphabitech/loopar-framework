'use strict';

/**
 * The core's log files, read per tenant — the ONE parser behind both the
 * terminal Tenant Manager (TUI) and the desk Debugger's Logs, so they always
 * show the same lines.
 *
 * What the files look like:
 *   - pm2 writes the core's stdout/stderr to two files, each line stamped
 *     "YYYY-MM-DD HH:mm:ss.SSS: " (coreConfig log_date_format). In cluster
 *     mode only the first line of a chunk carries it.
 *   - every line written inside a tenant's context starts with "[<tenant>] "
 *     (core/server/tenant-log-prefix.js), the lines of a multi-line message
 *     included. Unstamped continuation lines (older files) take the tenant of
 *     the line above. A continuation (indented: a stack frame, a wrapped
 *     object) groups under its first line in the Debugger.
 */

import fs from 'node:fs';
import path from 'node:path';

export const STAMP_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3}): /;
export const PREFIX_RE = /^\[([^\]\s]+)\] /;
export const CONTINUATION_RE = /^(\s|$)/;

/**
 * Parsing state across lines: `known` tenant names (so "[history]" or
 * "[Realtime]" module tags are not taken for tenants), the tenant to keep
 * (null = all) and, per stream, the last line's tenant and time.
 */
export function lineState({ known = [], tenant = null } = {}) {
  return {
    known: known instanceof Set ? known : new Set(known),
    tenant,
    lastT: { out: null, err: null },
    lastAt: { out: null, err: null },
  };
}

/** Split pm2's stamp off; unstamped lines take the stream's previous time. */
export function unstamp(st, stream, raw) {
  const m = STAMP_RE.exec(raw);
  if (!m) return { text: raw, at: st.lastAt[stream] ?? null };
  const at = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]).getTime();
  st.lastAt[stream] = at;
  return { text: raw.slice(m[0].length), at };
}

/** The tenant a line belongs to: its stamp, or the line above for a continuation. */
export function attribute(st, stream, text) {
  const m = PREFIX_RE.exec(text);
  let t = null;
  if (m && st.known.has(m[1])) t = m[1];
  else if (CONTINUATION_RE.test(text)) t = st.lastT[stream] ?? null;
  st.lastT[stream] = t;
  return t;
}

/**
 * One raw line → { s, text, t, at, cont } or null when the state's tenant
 * filters it out. In a single tenant's view its stamp is dropped from text.
 */
export function parseLine(st, stream, raw) {
  const { text, at } = unstamp(st, stream, raw);
  const t = attribute(st, stream, text);
  if (st.tenant && t !== st.tenant) return null;
  const body = t ? text.replace(PREFIX_RE, '') : text;
  return {
    s: stream,
    text: st.tenant ? body : text,
    t,
    at,
    cont: CONTINUATION_RE.test(body) && body !== '',
  };
}

/**
 * Fold continuation lines under the line they continue (same stream):
 * [{ at, s, text, cont }] in order → [{ at, s, text, stack: [] }].
 */
export function groupLines(lines) {
  const rows = [];
  const last = { out: null, err: null };
  for (const l of lines) {
    const prev = last[l.s];
    if (l.cont && prev) { prev.stack.push(l.text); continue; }
    const row = { at: l.at, s: l.s, text: l.text, stack: [] };
    rows.push(row);
    last[l.s] = row;
  }
  return rows;
}

/** The last `bytes` of a file as lines (the first, likely partial, dropped). */
export function readTail(file, bytes = 64 * 1024) {
  try {
    const { size } = fs.statSync(file);
    const start = Math.max(0, size - bytes);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    let lines = buf.toString('utf8').split('\n');
    if (start > 0) lines = lines.slice(1);
    if (lines[lines.length - 1] === '') lines.pop();
    return lines;
  } catch {
    return null;
  }
}

/**
 * Parse both streams and order them. `timed`: every line has a time, so
 * stdout and stderr interleave chronologically (newest last); otherwise
 * (files from before log_date_format) stdout's lines, then stderr's.
 */
export function readStreams(st, { out = [], err = [] }) {
  const parse = (stream, raw) => {
    st.lastT[stream] = null;
    st.lastAt[stream] = null;
    const list = [];
    raw.forEach((line, i) => {
      const e = parseLine(st, stream, line);
      if (e) list.push({ ...e, i });
    });
    return list;
  };
  const outE = parse('out', out);
  const errE = parse('err', err);
  const all = [...outE, ...errE];
  const timed = all.length > 0 && all.every((e) => e.at);
  if (timed) all.sort((a, b) => a.at - b.at || (a.s === b.s ? a.i - b.i : 0));
  return { out: outE, err: errE, merged: timed ? all : null, timed };
}

/**
 * Where the core's log files are. Inside the core pm2 puts them in the env
 * (pm_out_log_path / pm_err_log_path); from outside, the newest
 * loopar-core-{out,error}-N.log under PM2_HOME/logs.
 */
export function coreLogFiles({ name = 'loopar-core', root = process.cwd() } = {}) {
  if (process.env.pm_out_log_path || process.env.pm_err_log_path) {
    return { out: process.env.pm_out_log_path || null, err: process.env.pm_err_log_path || null };
  }
  const dir = path.join(process.env.PM2_HOME || path.join(root, '.pm2'), 'logs');
  const newest = (kind) => {
    try {
      const re = new RegExp(`^${name}-${kind}(-\\d+)?\\.log$`);
      return fs.readdirSync(dir)
        .filter((f) => re.test(f))
        .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.m - a.m)[0]?.f ?? null;
    } catch {
      return null;
    }
  };
  const out = newest('out');
  const err = newest('error');
  return { out: out ? path.join(dir, out) : null, err: err ? path.join(dir, err) : null };
}

const ERROR_RE = /^(\[5\d\d\]|\s*(?:[A-Z][A-Za-z]*Error|Error)\b\s*:|Uncaught\b|UnhandledPromiseRejection|FATAL\b)/;

/** A line's level as the files can tell it: stdout → log; stderr → error or warn. */
export function levelOf(stream, text) {
  if (stream !== 'err') return 'log';
  return ERROR_RE.test(text) ? 'error' : 'warn';
}
