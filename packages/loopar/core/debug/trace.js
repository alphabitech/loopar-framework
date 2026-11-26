'use strict';

/**
 * Where something happened, for the Debugger: V8 stack parsing into frames
 * (repo-relative paths, internal frames flagged), the first frame that is
 * ours (the origin) and a few source lines around it.
 *
 * Development tool only: reads source files from the repo on demand (cached
 * by mtime), never anything outside it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const SELF = path.resolve(fileURLToPath(new URL('./', import.meta.url)));

const FRAME_WITH_FN = /^\s*at\s+(?:(async)\s+)?(.*?)\s+\((.*)\)\s*$/;
const FRAME_BARE = /^\s*at\s+(?:(async)\s+)?(.*)\s*$/;
const LOCATION = /^(.*?):(\d+):(\d+)$/;
const SOURCE_EXT = /\.(m?js|jsx|cjs|ts|tsx)$/;

// Helpers that only build/raise an error: the origin is whoever called them.
const THROW_HELPERS = [
  /packages\/loopar\/core\/loopar\.js$/,
  /packages\/loopar\/core\/global\/http-errors\.js$/,
];

function toPath(location) {
  let file = location;
  if (file.startsWith('file://')) {
    try { file = fileURLToPath(file.split('?')[0]); } catch { /* keep raw */ }
  } else {
    file = file.split('?')[0];
  }
  return file;
}

/** One V8 stack line → { fn, file, line, col, internal, async } (null when it isn't a frame). */
export function parseFrame(text) {
  const raw = String(text ?? '');
  let m = raw.match(FRAME_WITH_FN);
  let fn = null, location, isAsync = false;
  if (m) {
    isAsync = !!m[1];
    fn = m[2] || null;
    location = m[3];
  } else {
    m = raw.match(FRAME_BARE);
    if (!m) return null;
    isAsync = !!m[1];
    location = m[2];
  }
  // "new Promise (<anonymous>)", "Array.map (<anonymous>)", "eval at …"
  const loc = String(location || '').match(LOCATION);
  if (!loc) {
    return { fn: fn || location || null, file: null, line: null, col: null, internal: true, async: isAsync };
  }
  const abs = toPath(loc[1]);
  const isNode = abs.startsWith('node:') || abs.startsWith('internal/');
  const rel = !isNode && path.isAbsolute(abs) && abs.startsWith(REPO_ROOT + path.sep)
    ? path.relative(REPO_ROOT, abs).split(path.sep).join('/')
    : abs;
  const internal = isNode || rel.includes('node_modules/') || !path.isAbsolute(abs) || !abs.startsWith(REPO_ROOT + path.sep) || abs.startsWith(SELF + path.sep);
  return { fn, file: rel, line: Number(loc[2]), col: Number(loc[3]), internal, async: isAsync };
}

/** A stack string → frames (the header lines — name: message — are skipped). */
export function parseStack(stack, max = 60) {
  if (!stack) return [];
  const frames = [];
  for (const line of String(stack).split('\n')) {
    if (!/^\s*at\s/.test(line)) continue;
    const f = parseFrame(line);
    if (f) frames.push(f);
    if (frames.length >= max) break;
  }
  return frames;
}

/** First frame of our code that isn't just an error-raising helper. */
export function originOf(frames) {
  const ours = frames.filter((f) => !f.internal && f.file);
  return ours.find((f) => !THROW_HELPERS.some((re) => re.test(f.file))) ?? ours[0] ?? null;
}

const sourceCache = new Map(); // abs → { mtimeMs, lines }

function readLines(abs) {
  try {
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size > 2_000_000) return null;
    const cached = sourceCache.get(abs);
    if (cached && cached.mtimeMs === st.mtimeMs) return cached.lines;
    const lines = fs.readFileSync(abs, 'utf8').split('\n');
    if (sourceCache.size > 200) sourceCache.clear();
    sourceCache.set(abs, { mtimeMs: st.mtimeMs, lines });
    return lines;
  } catch {
    return null;
  }
}

/**
 * Source lines around a frame: { file, line, start, lines: [..] }. Only repo
 * source files (never node_modules, never outside the repo).
 */
export function codeFrame(frame, around = 5) {
  if (!frame?.file || !frame.line || frame.internal || !SOURCE_EXT.test(frame.file)) return null;
  const abs = path.resolve(REPO_ROOT, frame.file);
  if (!abs.startsWith(REPO_ROOT + path.sep) || abs.includes(`${path.sep}node_modules${path.sep}`)) return null;
  const lines = readLines(abs);
  if (!lines || frame.line > lines.length) return null;
  const start = Math.max(1, frame.line - around);
  const end = Math.min(lines.length, frame.line + around);
  return {
    file: frame.file,
    line: frame.line,
    col: frame.col,
    start,
    lines: lines.slice(start - 1, end).map((l) => (l.length > 400 ? `${l.slice(0, 400)}…` : l)),
  };
}

/**
 * Where a console.* call came from: the first frame above `skipFn` that is
 * not node internals. Cheap (a few frames only).
 */
export function callSite(skipFn) {
  const holder = {};
  const limit = Error.stackTraceLimit;
  try {
    Error.stackTraceLimit = 8;
    Error.captureStackTrace(holder, skipFn);
  } finally {
    Error.stackTraceLimit = limit;
  }
  const frames = parseStack(holder.stack, 8);
  const f = frames.find((x) => x.file && !x.file.startsWith('node:') && !x.file.includes('node_modules/')) ?? frames[0];
  return f ? { fn: f.fn, file: f.file, line: f.line, col: f.col } : null;
}
