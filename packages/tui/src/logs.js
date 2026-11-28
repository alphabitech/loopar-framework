/**
 * Logs — realtime log stream, pm2-logs style. Shown by the LOGS tab (the
 * whole server) and, filtered to one tenant, by the "Logs" sub-tab of the
 * Tenants panel (`embedded`). The core stamps a tenant's lines with
 * "[<tenant>] " (core/server/tenant-log-prefix.js); continuation lines (a
 * stack trace) belong to the line above them. Scopes:
 */
import fs from "fs";
import pm2 from "pm2";
import { withPm2 } from "loopar/bin/pm2.js";
import { silenced } from "./term.js";
import { state, NO_PM2 } from "./state.js";
import { render } from "./render.js";
import { lineState, parseLine, unstamp, readTail, readStreams, coreLogFiles } from "loopar/core/logging/tenant-log.js";

const TAIL_BYTES = 64 * 1024;
const TAIL_BYTES_TENANT = 512 * 1024; // a tenant's lines are a fraction of the file
const HIST_LINES = 300;
const HIST_ALL = 12;
const HIST_ALL_ERR = 4;
const MAX_LINES = 2000;
const POLL_MS = 700;

let pollTimer = null;
let bus = null;
let busConnected = false;
let renderQueued = false;
let lastSig = "";

const meta = (text) => ({ s: "meta", text });

// The ONE parser of the core's log files (shared with the desk Debugger's
// Logs): pm2's time stamps, "[tenant] " stamps, continuation lines.
const entryOf = (L, stream, raw, extra = {}) => {
  const e = parseLine(L, stream, raw);
  return e ? { s: e.s, text: e.text, t: e.t, ...(e.at ? { at: e.at } : {}), ...extra } : null;
};

const visible = (L) => !!L && (L.embedded ? state.view === "tenants" : state.view === "logs");

function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  setTimeout(() => {
    renderQueued = false;
    if (visible(state.logs)) render();
  }, 80);
}

async function describePaths(name) {
  if (NO_PM2) return null;
  try {
    return await silenced(() => withPm2(() => new Promise((res) =>
      pm2.describe(name, (err, desc) => {
        const env = !err && desc?.[0]?.pm2_env;
        res(env ? { out: env.pm_out_log_path || null, err: env.pm_err_log_path || null } : null);
      })
    )));
  } catch (_) {
    return null;
  }
}

/** Every process pm2 knows about (any status), with its exact log paths. */
async function listProcs() {
  if (NO_PM2) return [];
  try {
    return await silenced(() => withPm2(() => new Promise((res) =>
      pm2.list((err, list) => res(err ? [] : (list || []).map((p) => ({
        name: p.name,
        out: p.pm2_env?.pm_out_log_path || null,
        err: p.pm2_env?.pm_err_log_path || null,
      }))))
    )));
  } catch (_) {
    return [];
  }
}



function buildHistory(L) {
  const bytes = L.tenant ? TAIL_BYTES_TENANT : TAIL_BYTES;
  const r = readStreams(L, {
    out: (L.paths.out && readTail(L.paths.out, bytes)) || [],
    err: (L.paths.err && readTail(L.paths.err, bytes)) || [],
  });
  const show = (e) => ({ s: e.s, text: e.text, t: e.t, ...(e.at ? { at: e.at } : {}) });
  if (!r.out.length && !r.err.length) {
    return [meta(L.tenant ? `(nothing logged for ${L.tenant} yet)` : "(no log output yet)")];
  }
  // Timed lines: one chronological stream (stdout and stderr interleaved,
  // newest at the bottom). Untimed files (before log_date_format): one block
  // per stream, as pm2 wrote them.
  if (r.timed) {
    const merged = r.merged.slice(-HIST_LINES).map(show);
    return [meta(`── last ${merged.length} lines ──`), ...merged];
  }
  const lines = [];
  if (r.out.length) lines.push(meta(`── stdout · last ${Math.min(r.out.length, HIST_LINES)} lines ──`), ...r.out.slice(-HIST_LINES).map(show));
  if (r.err.length) lines.push(meta(`── stderr · last ${Math.min(r.err.length, HIST_LINES)} lines ──`), ...r.err.slice(-HIST_LINES).map(show));
  return lines;
}

function buildHistoryAll(L) {
  const lines = [];
  for (const p of L.procs) {
    const out = (p.out && readTail(p.out)) || [];
    const err = (p.err && readTail(p.err)) || [];
    if (!out.length && !err.length) continue;
    lines.push(meta(`── ${p.name} ──`));
    lines.push(...out.slice(-HIST_ALL).map((t) => ({ s: "out", ...unstamp(L, "out", t), p: p.name })));
    lines.push(...err.slice(-HIST_ALL_ERR).map((t) => ({ s: "err", ...unstamp(L, "err", t), p: p.name })));
  }
  if (!lines.length) lines.push(meta("(no pm2 processes with logs — is anything running?)"));
  return lines.slice(-MAX_LINES);
}

// ─── Live stream (pm2 event bus — what `pm2 logs` uses) ─────────────────────

function onPacket(kind, packet) {
  const L = state.logs;
  if (!L) return;
  const pname = packet?.process?.name;
  if (L.name && pname !== L.name) return; // one-process scope filters
  for (const raw of String(packet.data ?? "").split("\n")) {
    if (raw === "") continue;
    const e = entryOf(L, kind, raw, { p: L.name ? undefined : pname });
    if (e && !e.at) e.at = packet.at || Date.now();
    if (e) L.lines.push(e);
  }
  if (L.lines.length > MAX_LINES) L.lines.splice(0, L.lines.length - MAX_LINES);
  scheduleRender();
}

/**
 * The live stream gets its OWN pm2 client: the rest of the TUI talks to pm2
 * through withPm2(), which disconnects the shared client after every call —
 * the status refresh every few seconds used to cut the bus and the panel's
 * logs stopped being live.
 */
let busClient = null;

function startBus() {
  if (NO_PM2) return Promise.resolve(false);
  return new Promise((resolve) => {
    busClient = new pm2.custom({ pm2_home: process.env.PM2_HOME });
    busClient.connect((err) => {
      if (err) return resolve(false);
      busConnected = true;
      busClient.launchBus((err2, b) => {
        if (err2 || !b) return resolve(false);
        bus = b;
        bus.on("log:out", (p) => onPacket("out", p));
        bus.on("log:err", (p) => onPacket("err", p));
        resolve(true);
      });
    });
  });
}

function pollFallback() {
  const L = state.logs;
  if (!visible(L)) return;
  const files = L.name
    ? [L.paths.out, L.paths.err]
    : L.procs.flatMap((p) => [p.out, p.err]);
  const sig = files.map((f) => {
    try { return f ? fs.statSync(f).size : 0; } catch (_) { return 0; }
  }).join(":");
  if (sig === lastSig) return;
  lastSig = sig;
  L.lines = L.name ? buildHistory(L) : buildHistoryAll(L);
  render();
}


/**
 * name = one pm2 process (the core); null = every pm2 process, merged.
 * opts.tenant: only that tenant's lines. opts.embedded: shown inside the
 * Tenants panel (doesn't switch to the LOGS tab).
 */
export async function openLogs(name = null, { tenant = null, embedded = false } = {}) {
  closeLogs();
  if (!embedded) state.view = "logs";
  state.logs = {
    name, // null = all-processes scope
    embedded,
    ...lineState({ known: state.rows.map((r) => r.name), tenant }),
    lines: [meta("resolving log files...")],
    follow: true, // pinned to the tail; scrolling pauses, [f] resumes
    scroll: 0,
    viewH: 10, // render() keeps this in sync with the real window
    paths: { out: null, err: null },
    procs: [],
    live: false,
  };
  render();

  const L = state.logs;
  if (name) {
    const described = await describePaths(name);
    if (state.logs !== L) return; // user left the tab mid-await
    L.paths = {
      out: described?.out || coreLogFiles({ name }).out,
      err: described?.err || coreLogFiles({ name }).err,
    };
    L.lines = buildHistory(L);
  } else {
    L.procs = await listProcs();
    if (state.logs !== L) return;
    L.lines = buildHistoryAll(L);
  }
  render();

  L.live = await startBus();
  if (state.logs !== L) return;
  if (L.live) {
    L.lines.push(meta("── live ──"));
    render();
  } else {
    lastSig = "";
    pollTimer = setInterval(pollFallback, POLL_MS);
  }
}

export function closeLogs() {
  const wasEmbedded = !!state.logs?.embedded;
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (bus) { try { bus.close(); } catch (_) { /* already gone */ } bus = null; }
  if (busConnected) { try { busClient?.disconnect(); } catch (_) { /* already gone */ } busConnected = false; }
  busClient = null;
  lastSig = "";
  state.logs = null;
  if (!wasEmbedded) state.view = "tenants";
}

/** F5 — re-resolve paths and rebuild history (restarts the live stream). */
export function reloadLogs() {
  const L = state.logs;
  if (L) openLogs(L.name || null, { tenant: L.tenant, embedded: L.embedded });
}
