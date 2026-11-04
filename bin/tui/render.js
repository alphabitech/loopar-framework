import { A, LOG, pad, link, stripAnsi } from "./term.js";
import { state, NO_PM2 } from "./state.js";
import { corePort, coreEnv } from "loopar/core/config/core-config.js";

const ESC = "\x1b";
const MAGENTA = `${ESC}[35m`;
const BLUE = `${ESC}[34m`;
const WHITE = `${ESC}[37m`;
const U = `${ESC}[4m`; // underline on (hotkey letter)
const UO = `${ESC}[24m`; // underline off

// Colored chip with GUARANTEED contrast: background color code + a
// foreground chosen per background (black on light, bright white on dark).
const PILL_BG = {
  green:   { bg: "42",  fg: "30" },
  yellow:  { bg: "43",  fg: "30" },
  cyan:    { bg: "46",  fg: "30" },
  white:   { bg: "47",  fg: "30" },
  red:     { bg: "41",  fg: "97" },
  blue:    { bg: "44",  fg: "97" },
  magenta: { bg: "45",  fg: "97" },
  gray:    { bg: "100", fg: "97" },
};
const pill = (label, color = "white") => {
  const c = PILL_BG[color] || PILL_BG.white;
  return `${ESC}[${c.bg};${c.fg}m${label}${A.reset}`;
};

// Stable per-process color for the all-logs prefix (red is reserved for
// stderr bodies, so it's not in the palette).
const NAME_COLORS = [A.cyan, A.green, A.yellow, MAGENTA, BLUE, WHITE];
function nameColor(n) {
  let h = 0;
  for (let i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) >>> 0;
  return NAME_COLORS[h % NAME_COLORS.length];
}

// Core model: no per-tenant port or mode — a tenant is just name + domain +
// logical status. (Mode is core-level; see config/core.json.)
const COLS = [
  { key: "name", label: "TENANT", w: 24 },
  { key: "url", label: "URL", w: 48 },
  { key: "status", label: "ST", w: 4 },
];

// Media-style state glyphs: compact, readable by shape even without color.
const STATUS_META = {
  online:    { dot: "▶", color: A.green },
  stopped:   { dot: "■", color: A.red },
  errored:   { dot: "✖", color: A.red },
  launching: { dot: "◐", color: A.yellow },
  "n/a":     { dot: "◌", color: A.gray },
  "…":       { dot: "◌", color: A.gray },
};
const statusMeta = (s) => STATUS_META[s] || { dot: "◐", color: A.yellow };

function hr(width) {
  return A.gray + "─".repeat(Math.min(width, 100)) + A.reset;
}

/** Title + spacer + clickable [Tenants][Logs] tabs + separator (4 lines). */
function pushHeader(lines, width) {
  // The core (generator) this manager talks to — from config/core.json.
  let coreInfo;
  try { coreInfo = `${A.gray}core :${corePort()} · ${coreEnv()}${A.reset}`; }
  catch { coreInfo = `${A.gray}core${A.reset}`; }

  // Live core-process chip (state.coreStatus, set by loadRows).
  const cs = state.coreStatus;
  const serverChip =
    cs === "online" ? pill(" ● server up ", "green") :
    cs == null       ? `${A.gray}server …${A.reset}` :
                       pill(" ✖ server down · press c ", "red");

  lines.push(` ${pill(` ◆ LOOPAR `, "cyan")} ${A.bold}Tenant Manager${A.reset}  ${coreInfo}   ${serverChip}`);
  lines.push(""); // breathing room so the title pill and the active tab don't stack

  const logsLabel = `LOGS${state.logs ? ` · ${state.logs.name || "all"}` : ""}`;
  const run = state.tests?.handle?.run;
  const testsLabel = !run ? "TESTS"
    : run.status === "running" ? `TESTS · ◐ ${run.counts.pass}✓ ${run.counts.fail}✗`
    : `TESTS · ${run.counts.fail ? `${run.counts.fail}✗` : `${run.counts.pass}✓`}`;
  const tabs = [
    { label: "TENANTS", view: "tenants", action: "tab-tenants" },
    { label: logsLabel, view: "logs", action: "tab-logs" },
    { label: testsLabel, view: "tests", action: "tab-tests" },
    { label: `BACKUPS${state.backups?.tenant ? ` · ${state.backups.tenant}` : ""}`, view: "backups", action: "tab-backups" },
  ];
  let x = 2; // line starts with one space; x is 1-based
  const parts = [];
  for (const t of tabs) {
    const rendered = ` ${t.label} `;
    state.buttonRegions.push({ x1: x, x2: x + rendered.length - 1, y: 3, action: t.action });
    parts.push(
      state.view === t.view
        ? pill(rendered, "cyan")
        : `${A.dim}${rendered}${A.reset}`
    );
    x += rendered.length + 1;
  }
  lines.push(" " + parts.join(" "));
  lines.push(hr(width));
}

function renderTenants(lines, width, height) {
  // ── Horizontal column window ──
  // TENANT is frozen; the remaining columns are windowed by the available
  // width and shifted with ←/→ (state.colOff). Rows never exceed the
  // terminal width, so narrow consoles CLIP columns instead of wrapping —
  // wrapped rows used to overlap and corrupt the whole frame.
  const nameCol = COLS[0];
  const rest = COLS.slice(1);
  const avail = width - 2 - nameCol.w; // 2-char row prefix
  const totalRestW = rest.reduce((s, c) => s + c.w, 0);
  if (totalRestW <= avail) state.colOff = 0; // everything fits — no window
  state.colOff = Math.min(Math.max(0, state.colOff || 0), rest.length - 1);
  const visCols = [];
  let usedW = 0;
  for (let i = state.colOff; i < rest.length; i++) {
    if (usedW + rest[i].w > avail && visCols.length) break;
    visCols.push(rest[i]);
    usedW += rest[i].w;
  }
  const shownCols = [nameCol, ...visCols];
  const moreLeft = state.colOff > 0;
  const moreRight = state.colOff + visCols.length < rest.length;

  // x-range of the URL column (rows start with a 2-char prefix, x is 1-based)
  // — the mouse handler turns a click there into "open in browser". Only
  // valid while the URL column is inside the window.
  let colX = 3;
  state.urlCol = null;
  for (const c of shownCols) {
    if (c.key === "url") { state.urlCol = { x1: colX, x2: colX + c.w - 1 }; break; }
    colX += c.w;
  }

  // Column header (‹ › mark columns hidden beyond each edge)
  const headCells = shownCols.map((c) => `${A.bold}${A.gray}${pad(c.label, c.w)}${A.reset}`).join("");
  const marks = `${moreLeft ? `${A.cyan}‹${A.reset}` : ""}${moreRight ? `${A.cyan}›${A.reset}` : ""}`;
  lines.push("  " + headCells + marks);

  // Table window (header 4 + col header 1 + scroll 1 + sep 1 + footer 1 + msg 1)
  const tableHeight = Math.max(3, height - 10);
  state.tableH = tableHeight; // PgUp/PgDn page size for the input handler
  state.rowRegionStart = lines.length + 1; // 1-based terminal row of first tenant row

  if (state.selected < state.scroll) state.scroll = state.selected;
  if (state.selected >= state.scroll + tableHeight) state.scroll = state.selected - tableHeight + 1;

  const visible = state.rows.slice(state.scroll, state.scroll + tableHeight);
  for (let i = 0; i < visible.length; i++) {
    const row = visible[i];
    const isSel = state.scroll + i === state.selected;
    const cells = shownCols.map((c) => {
      const raw = String(row[c.key] ?? "");
      if (c.key === "name") {
        // Plain uppercased text for scanability. Deliberately NO OSC 8 link
        // here — the terminal's hover tooltip ("cmd+click") got in the way of
        // plain row clicks, and the URL column / double-click already cover
        // opening the browser.
        const plain = (raw.length > c.w - 1 ? raw.slice(0, c.w - 1) : raw).toUpperCase();
        return (isSel ? `${A.bold}${plain}` : plain) + " ".repeat(c.w - plain.length);
      }
      if (c.key === "url") {
        const u = raw.length > c.w - 3 ? raw.slice(0, c.w - 4) + "…" : raw;
        const txt = u ? `${u} ↗` : "";
        if (isSel) return pad(txt, c.w); // uniform selection bar — no colors inside
        return pad(u ? `${A.cyan}${txt}${A.reset}` : "", c.w);
      }
      if (c.key === "status") {
        const m = statusMeta(row.status);
        if (isSel) return pad(m.dot, c.w);
        return pad(`${m.color}${m.dot}${A.reset}`, c.w);
      }
      return pad(raw, c.w);
    }).join("");
    lines.push(isSel ? `${A.inv}❯ ${cells}${A.reset}` : `  ${cells}`);
  }

  // Empty state: guide instead of a blank void.
  if (state.rows.length === 0) {
    lines.push("");
    lines.push(`   ${A.dim}No tenants in sites/ yet.${A.reset}`);
    lines.push(`   ${A.dim}Press ${A.reset}${pill(` ✚ ${U}N${UO}ew `, "blue")}${A.dim} to create your first one.${A.reset}`);
    for (let i = 3; i < tableHeight; i++) lines.push("");
  } else {
    for (let i = visible.length; i < tableHeight; i++) lines.push("");
  }

  // Scroll indicator when the list overflows; state-glyph legend otherwise.
  const legend = `  ${A.green}▶${A.reset}${A.dim} online · ${A.reset}${A.red}■${A.reset}${A.dim} stopped · ${A.reset}${A.red}✖${A.reset}${A.dim} errored${A.reset}`;
  const colHint = (moreLeft || moreRight) ? `${A.dim} · ←→ columns${A.reset}` : "";
  const scrollInfo = state.rows.length > tableHeight
    ? `${A.dim}  ${state.scroll + 1}–${Math.min(state.scroll + tableHeight, state.rows.length)} of ${state.rows.length} · PgUp/PgDn page · Home/End jump${A.reset}${legend}`
    : (state.rows.length ? legend : "");
  lines.push(scrollInfo + colHint);
  lines.push(hr(width));

  // Footer: mode-dependent
  if (state.mode === "create" && state.wizard) {
    const w = state.wizard;
    const st = w.steps[w.idx];
    const dots = w.steps.map((_, i) =>
      i < w.idx ? `${A.green}●${A.reset}` : i === w.idx ? `${A.cyan}●${A.reset}` : `${A.gray}○${A.reset}`
    ).join(" ");
    const shown = st.mask ? "*".repeat(state.input.length) : state.input;
    lines.push(` ${pill(` ${w.title} `, "cyan")} ${dots}  ${A.bold}${st.label}${A.reset} ${A.gray}›${A.reset} ${shown}${A.inv} ${A.reset}  ${A.dim}Enter next · Esc cancel${A.reset}`);
  } else if (state.mode === "confirm" && state.confirm) {
    const y = lines.length + 1;
    const yesLabel = ` ✓ ${U}Y${UO}es `;
    const noLabel = ` ✗ ${U}N${UO}o `;
    const yesW = stripAnsi(yesLabel).length;
    const noW = stripAnsi(noLabel).length;
    const prefix = ` ${A.yellow}◆ ${state.confirm.question}${A.reset}  `;
    const px = stripAnsi(prefix).length;
    state.buttonRegions.push({ x1: px + 1, x2: px + yesW, y, action: "confirm-yes" });
    state.buttonRegions.push({ x1: px + yesW + 2, x2: px + yesW + 1 + noW, y, action: "confirm-no" });
    lines.push(`${prefix}${pill(yesLabel, "green")} ${pill(noLabel, "red")}  ${A.dim}Esc cancel${A.reset}`);
  } else if (state.mode === "destroy") {
    const target = state.rows[state.selected]?.name || "";
    lines.push(` ${pill(` ⚠ DESTROY `, "red")} ${A.red}deletes sites/${target} from disk.${A.reset} Type the tenant name to confirm ${A.gray}›${A.reset} ${state.input}${A.inv} ${A.reset} ${A.dim}Esc cancel${A.reset}`);
  } else {
    const buttons = [
      { label: ` ▶ ${U}S${UO}tart `, w: 9, color: "green", action: "start" },
      { label: ` ■ S${U}t${UO}op `, w: 8, color: "yellow", action: "stop" },
      { label: ` ↻ ${U}R${UO}estart `, w: 11, color: "cyan", action: "restart" },
      { label: ` ≣ ${U}L${UO}ogs `, w: 8, color: "white", action: "logs" },
      { label: ` ⇄ ${U}M${UO}ode `, w: 8, color: "magenta", action: "mode" },
      { label: ` ✚ ${U}N${UO}ew `, w: 7, color: "blue", action: "new" },
      { label: ` ✕ ${U}D${UO}estroy `, w: 11, color: "red", action: "destroy" },
      { label: ` ${U}Q${UO}uit `, w: 6, color: "gray", action: "quit" },
    ];
    let x = 1;
    const y = lines.length + 1;
    const parts = [];
    for (const b of buttons) {
      state.buttonRegions.push({ x1: x, x2: x + b.w - 1, y, action: b.action });
      x += b.w + 1;
      parts.push(pill(b.label, b.color));
    }
    lines.push(parts.join(" "));
  }

  // Message / selected tenant URL (underlined hyperlink where supported)
  const sel = state.rows[state.selected];
  const url = sel?.url && state.mode === "list"
    ? `${A.cyan}${A.under}${link(sel.url, sel.url)}${A.reset}`
    : "";
  const icon = state.messageKind === "error" ? `${A.red}✗` : state.messageKind === "ok" ? `${A.green}✓` : `${A.gray}·`;
  const msgColor = state.messageKind === "error" ? A.red : state.messageKind === "ok" ? A.green : A.dim;
  lines.push(state.busy
    ? ` ${A.yellow}◐ working...${A.reset}`
    : ` ${icon} ${msgColor}${state.message}${A.reset}  ${url}`);
}

// ─── Log line classification ─────────────────────────────────────────────────
// pm2 only tells us the STREAM (stdout/stderr); everything React, Node and the
// core write as a warning also lands on stderr, so painting the whole stream
// red buried the actual error. Color by what the line IS instead:
//   error headline  → bold red      [500] … / SyntaxError: … / Error: …
//   stack frame     → gray, but frames in OUR code keep the normal color
//   4xx / warning   → yellow        [404] … / Warning: … / React key warnings
//   anything else   → stream default (stderr = plain, not red)
const FRAME_RE = /^\s+at\s/;
const ERROR_RE = /^(\[5\d\d\]|\s*(?:[A-Z][A-Za-z]*Error|Error)\b\s*:|Uncaught\b|UnhandledPromiseRejection|FATAL\b)/;
const HTTP_WARN_RE = /^\[[34]\d\d\]/;
// Chatter: real warnings, but ones you rarely act on from the log tail.
const NOISE_WARN_RE = /^(\(node:\d+\)\s*(?:\[\w+\]\s*)?Warning:|Warning:|Each child in a list|Check the render method|React does not recognize|Received `|Invalid DOM property|Unsupported style property|In HTML,|\[Cache\]|.*⚠)/;
// Continuation lines of a warning ("(Use `node --trace-warnings ...`", "See https://…").
const CONT_RE = /^(\(Use `node --trace-warnings|See https?:\/\/|\s{2,}\S)/;
const NOISE_FRAME_RE = /node_modules|node:internal|<anonymous>|react-dom-server|react\.development/;

function paintLog(text, stream) {
  if (FRAME_RE.test(text)) return NOISE_FRAME_RE.test(text) ? LOG.frame : LOG.ownFrame;
  if (ERROR_RE.test(text)) return LOG.error;
  if (HTTP_WARN_RE.test(text)) return LOG.http;
  if (NOISE_WARN_RE.test(text)) return LOG.noise;
  if (CONT_RE.test(text)) return LOG.cont;
  return "";
}

function renderLogs(lines, width, height) {
  const L = state.logs;
  const scopeInfo = L.name
    ? (L.paths.out || L.paths.err || "no log file found")
    : `${L.procs.length} pm2 processes, merged live`;
  lines.push(` ${pill(` ${L.name || "ALL"} `, "cyan")} ${A.dim}${scopeInfo}${A.reset}`);

  // header 4 + info 1 + sep 1 + footer 1 → log window fills the rest
  const viewH = Math.max(3, height - 7);
  L.viewH = viewH;

  const total = L.lines.length;
  const maxStart = Math.max(0, total - viewH);
  if (L.follow) L.scroll = maxStart;
  else L.scroll = Math.min(Math.max(0, L.scroll), maxStart);

  const shown = L.lines.slice(L.scroll, L.scroll + viewH);
  for (const e of shown) {
    if (e.s === "meta") { lines.push(` ${A.dim}${e.text}${A.reset}`); continue; }
    // Live lines carry the bus timestamp; history lines don't.
    const time = e.at ? `${A.dim}${new Date(e.at).toTimeString().slice(0, 8)}${A.reset} ` : "";
    const timeW = e.at ? 9 : 0;
    // All-processes scope: pm2-logs style name prefix, colored per process.
    const pName = e.p ? (e.p.length > 12 ? e.p.slice(0, 12) : e.p) : "";
    const pfx = e.p ? `${nameColor(e.p)}${pName.padEnd(12)}${A.reset} ${A.gray}│${A.reset} ` : "";
    const pfxW = e.p ? 15 : 0;
    const plain = stripAnsi(e.text);
    const color = paintLog(plain, e.s);
    const room = width - 2 - timeW - pfxW;
    // Keep the app's own ANSI when the line fits; drop it when truncating
    // (slicing mid-escape corrupts the frame).
    const body = plain.length > room ? plain.slice(0, room) : e.text;
    lines.push(` ${time}${pfx}${color}${body}${A.reset}`);
  }
  for (let i = shown.length; i < viewH; i++) lines.push("");

  lines.push(hr(width));
  const pos = total ? `${L.scroll + 1}–${Math.min(L.scroll + viewH, total)}/${total}` : "0/0";
  const mode = L.live ? `${A.green}● live${A.reset}` : `${A.yellow}◐ polling${A.reset}`;
  const follow = L.follow
    ? pill(` following `, "green")
    : pill(` paused · ${U}f${UO} follows `, "yellow");
  const scopeKey = L.name ? `${U}a${UO} all procs` : `${U}a${UO} one tenant`;
  lines.push(` ${A.dim}Tab/Esc tenants · ${scopeKey} · ↑↓/wheel scroll · F5 reload · q quit${A.reset}  ${mode}  ${follow}  ${A.dim}${pos}${A.reset}`);
}

// ─── Tests tab ───────────────────────────────────────────────────────────────

const FILE_GLYPH = {
  running:   { g: "◐", c: A.yellow },
  passed:    { g: "✓", c: A.green },
  failed:    { g: "✗", c: A.red },
  cancelled: { g: "■", c: A.gray },
  none:      { g: "◌", c: A.gray },
};

const cut = (text, n) => {
  const t = String(text ?? "");
  if (n <= 0) return "";
  return t.length > n ? t.slice(0, Math.max(0, n - 1)) + "…" : t;
};

function fileStatus(run, file) {
  const f = run?.files?.[file];
  if (!f) return run?.status === "running" && run.current?.file === file ? "running" : "none";
  if (run.status === "running") return f.fail > 0 ? "failed" : "running";
  return f.status || "none";
}

/** Right pane: failures with their diff, then the tail of the output. */
function testDetailLines(run, total) {
  const out = [];
  const push = (text, color = "") => out.push({ text: String(text ?? ""), color });
  if (!run) {
    push("No run yet.", A.dim);
    push("");
    push("a  run every test           u  unit only", A.dim);
    push("i  integration only         ⏎  picked files (space picks)", A.dim);
    push("f  re-run the failed files  x  stop the run", A.dim);
    push("");
    push(`${total} test files under test/`, A.dim);
    return out;
  }
  for (const f of run.failures) {
    push(`✗ ${[...(f.path || []), f.name].join(" › ")}`, `${A.bold}${A.red}`);
    push(`  ${f.file}${f.line ? `:${f.line}` : ""}${f.durationMs != null ? `  (${Math.round(f.durationMs)}ms)` : ""}`, A.dim);
    const e = f.error || {};
    const msg = String(e.message || "(no message)").split("\n").filter((l) => l.trim() !== "").slice(0, 8);
    for (const l of msg) push(`  ${l}`, LOG.error);
    if (e.actual !== undefined || e.expected !== undefined) {
      push(`  actual:   ${String(e.actual).split("\n")[0]}`, A.yellow);
      push(`  expected: ${String(e.expected).split("\n")[0]}`, A.green);
    }
    const frame = String(e.stack || "").split("\n").find((l) => /^\s+at\s/.test(l) && !/node:internal|node_modules/.test(l));
    if (frame) push(`  ${frame.trim()}`, LOG.ownFrame);
    push("");
  }
  if (!run.failures.length) {
    if (run.status === "passed") push(`✓ all ${run.counts.tests} tests passed`, `${A.bold}${A.green}`);
    else if (run.status === "running") push(`running… ${run.counts.tests} done`, A.yellow);
    else push(`${run.status} (exit ${run.exitCode ?? "?"})`, A.yellow);
    push("");
  }
  const tail = run.output.slice(-12);
  if (tail.length) {
    push("── output ──", A.dim);
    for (const o of tail) push(`${o.file ? `[${o.file.replace(/^test\//, "")}] ` : ""}${o.text}`, o.stream === "runner" ? LOG.noise : A.dim);
  }
  return out;
}

function renderTests(lines, width, height) {
  const t = state.tests;
  const run = t.handle?.run || null;
  const c = run?.counts;

  // Info line
  const chip = !run ? pill(" NO RUN ", "gray")
    : run.status === "running" ? pill(" ◐ RUNNING ", "yellow")
    : run.status === "passed" ? pill(" ✓ PASSED ", "green")
    : pill(` ✗ ${run.status.toUpperCase()} `, "red");
  const secs = run ? (((run.durationMs ?? (Date.now() - Date.parse(run.startedAt))) / 1000).toFixed(1) + "s") : "";
  const counts = run
    ? ` ${A.green}${c.pass} passed${A.reset} ${c.fail ? A.red : A.dim}${c.fail} failed${A.reset}${c.skip ? ` ${A.dim}${c.skip} skipped${A.reset}` : ""} ${A.dim}${secs}${A.reset}`
    : ` ${A.dim}${t.files.length} files${A.reset}`;
  const current = run?.status === "running" && run.current
    ? `  ${A.dim}› ${cut(`${run.current.file} › ${run.current.name}`, Math.max(10, width - 50))}${A.reset}`
    : "";
  lines.push(` ${chip}${counts}${current}`);

  // header 4 + info 1 + sep 1 + footer 1 + msg 1
  const bodyH = Math.max(3, height - 8);
  t.listH = bodyH;
  const leftW = Math.min(52, Math.max(30, Math.floor(width * 0.4)));
  const rightW = Math.max(10, width - leftW - 4);

  if (t.cursor < t.scroll) t.scroll = t.cursor;
  if (t.cursor >= t.scroll + bodyH) t.scroll = t.cursor - bodyH + 1;
  const shown = t.files.slice(t.scroll, t.scroll + bodyH);
  state.testRowStart = lines.length + 1; // 1-based terminal row of the first file

  const detail = testDetailLines(run, t.files.length);
  const maxScroll = Math.max(0, detail.length - bodyH);
  t.detailScroll = Math.min(t.detailScroll, maxScroll);
  const right = detail.slice(t.detailScroll, t.detailScroll + bodyH);

  for (let i = 0; i < bodyH; i++) {
    let left = " ".repeat(leftW);
    const f = shown[i];
    if (f) {
      const idx = t.scroll + i;
      const isCur = idx === t.cursor;
      const st = FILE_GLYPH[fileStatus(run, f.file)];
      const rf = run?.files?.[f.file];
      const tally = rf ? `${rf.pass}/${rf.fail}` : "";
      const box = t.picked.has(f.file) ? "[x]" : "[ ]";
      const nameW = leftW - 8 - tally.length - 1;
      const name = cut(f.file.replace(/^test\//, ""), nameW).padEnd(nameW);
      const body = `${box} ${st.c}${st.g}${A.reset}${isCur ? A.inv : ""} ${name} ${tally}${A.reset}`;
      left = isCur ? `${A.inv}❯ ${A.reset}${body}` : `  ${body}`;
    }
    const r = right[i];
    const rText = r ? `${r.color}${cut(r.text, rightW)}${A.reset}` : "";
    lines.push(` ${left} ${A.gray}│${A.reset} ${rText}`);
  }

  lines.push(hr(width));

  const buttons = [
    { label: ` ▶ ${U}A${UO}ll `, w: 7, color: "green", action: "tests-all" },
    { label: ` ${U}U${UO}nit `, w: 6, color: "cyan", action: "tests-unit" },
    { label: ` ${U}I${UO}ntegration `, w: 13, color: "cyan", action: "tests-integration" },
    { label: ` ⏎ Picked${t.picked.size ? ` (${t.picked.size})` : ""} `, w: 10 + (t.picked.size ? String(t.picked.size).length + 3 : 0), color: "white", action: "tests-selected" },
    { label: ` ↻ ${U}F${UO}ailed `, w: 10, color: "yellow", action: "tests-failed" },
    { label: ` ■ Stop ${U}x${UO} `, w: 10, color: "red", action: "tests-stop" },
    { label: ` Esc `, w: 5, color: "gray", action: "tab-tenants" },
  ];
  let x = 1;
  const y = lines.length + 1;
  const parts = [];
  for (const b of buttons) {
    state.buttonRegions.push({ x1: x, x2: x + b.w - 1, y, action: b.action });
    x += b.w + 1;
    parts.push(pill(b.label, b.color));
  }
  lines.push(parts.join(" ") + `  ${A.dim}↑↓ move · space pick · PgUp/PgDn results${A.reset}`);

  const icon = state.messageKind === "error" ? `${A.red}✗` : state.messageKind === "ok" ? `${A.green}✓` : `${A.gray}·`;
  const msgColor = state.messageKind === "error" ? A.red : state.messageKind === "ok" ? A.green : A.dim;
  lines.push(` ${icon} ${msgColor}${state.message}${A.reset}`);
}

// ─── Backups tab ─────────────────────────────────────────────────────────────

const KIND_COLOR = { scheduled: A.cyan, manual: MAGENTA, "pre-update": A.yellow, "pre-restore": A.yellow, uploaded: A.gray };
const fmtBytes = (n) => (n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round((n || 0) / 1024))} KB`);
const fmtWhen = (d) => {
  const x = new Date(d);
  const p = (v) => String(v).padStart(2, "0");
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())} ${p(x.getHours())}:${p(x.getMinutes())}`;
};

/** Footer for the modal modes (wizard / confirm), shared by the full-screen tabs. */
function modalFooter(lines) {
  if (state.mode === "create" && state.wizard) {
    const w = state.wizard;
    const st = w.steps[w.idx];
    const shown = st.mask ? "*".repeat(state.input.length) : state.input;
    lines.push(` ${pill(` ${w.title} `, "cyan")} ${A.bold}${st.label}${A.reset} ${A.gray}›${A.reset} ${shown}${A.inv} ${A.reset}  ${A.dim}Enter next · Esc cancel${A.reset}`);
    return true;
  }
  if (state.mode === "confirm" && state.confirm) {
    const y = lines.length + 1;
    const yesLabel = ` ✓ ${U}Y${UO}es `;
    const noLabel = ` ✗ ${U}N${UO}o `;
    const prefix = ` ${A.yellow}◆ ${state.confirm.question}${A.reset}  `;
    const px = stripAnsi(prefix).length;
    const yesW = stripAnsi(yesLabel).length;
    state.buttonRegions.push({ x1: px + 1, x2: px + yesW, y, action: "confirm-yes" });
    state.buttonRegions.push({ x1: px + yesW + 2, x2: px + yesW + 1 + stripAnsi(noLabel).length, y, action: "confirm-no" });
    lines.push(`${prefix}${pill(yesLabel, "green")} ${pill(noLabel, "red")}  ${A.dim}Esc cancel${A.reset}`);
    return true;
  }
  return false;
}

function renderBackups(lines, width, height) {
  const b = state.backups;
  const where = b.destination ? `this server + ${b.destination}` : "this server only";
  lines.push(` ${pill(` ${b.tenant} `, "cyan")} ${A.dim}${b.rows.length} backup(s) · ${where}${b.loading ? " · loading…" : ""}${A.reset}`);
  lines.push(`  ${A.bold}${A.gray}${pad("DATE", 18)}${pad("KIND", 13)}${pad("SIZE", 10)}${pad("WHERE", 18)}FILE${A.reset}`);

  // header 4 + info 2 + sep 1 + footer 1 + msg 1
  const listH = Math.max(3, height - 9);
  b.listH = listH;
  if (b.cursor < b.scroll) b.scroll = b.cursor;
  if (b.cursor >= b.scroll + listH) b.scroll = b.cursor - listH + 1;
  const shown = b.rows.slice(b.scroll, b.scroll + listH);
  for (let i = 0; i < listH; i++) {
    const r = shown[i];
    if (!r) { lines.push(i === 0 && !b.rows.length ? `   ${A.dim}No backups yet — press n to make one.${A.reset}` : ""); continue; }
    const isCur = b.scroll + i === b.cursor;
    const loc = [r.local ? "local" : null, r.remote ? "remote" : null].filter(Boolean).join("+") + (r.encrypted ? " ·enc" : "");
    const fileW = Math.max(10, width - 2 - 18 - 13 - 10 - 18 - 1);
    const fileTxt = r.file.length > fileW ? r.file.slice(0, fileW - 1) + "…" : r.file;
    if (isCur) {
      lines.push(`${A.inv}❯ ${pad(fmtWhen(r.date), 18)}${pad(r.kind, 13)}${pad(fmtBytes(r.size), 10)}${pad(loc, 18)}${fileTxt}${A.reset}`);
    } else {
      lines.push(`  ${pad(fmtWhen(r.date), 18)}${KIND_COLOR[r.kind] || ""}${pad(r.kind, 13)}${A.reset}${pad(fmtBytes(r.size), 10)}${A.dim}${pad(loc, 18)}${fileTxt}${A.reset}`);
    }
  }
  lines.push(hr(width));

  if (!modalFooter(lines)) {
    const buttons = [
      { label: ` ✚ ${U}N${UO}ew backup `, w: 14, color: "green", action: "backups-new" },
      { label: ` ↺ ${U}R${UO}estore `, w: 11, color: "yellow", action: "backups-restore" },
      { label: ` ✕ ${U}D${UO}elete `, w: 10, color: "red", action: "backups-delete" },
      { label: ` F5 reload `, w: 11, color: "white", action: "backups-reload" },
      { label: ` Esc `, w: 5, color: "gray", action: "tab-tenants" },
    ];
    let x = 1;
    const y = lines.length + 1;
    const parts = [];
    for (const btn of buttons) {
      state.buttonRegions.push({ x1: x, x2: x + btn.w - 1, y, action: btn.action });
      x += btn.w + 1;
      parts.push(pill(btn.label, btn.color));
    }
    lines.push(parts.join(" "));
  }

  const icon = state.messageKind === "error" ? `${A.red}✗` : state.messageKind === "ok" ? `${A.green}✓` : `${A.gray}·`;
  const msgColor = state.messageKind === "error" ? A.red : state.messageKind === "ok" ? A.green : A.dim;
  lines.push(state.busy ? ` ${A.yellow}◐ ${state.message || "working..."}${A.reset}` : ` ${icon} ${msgColor}${state.message}${A.reset}`);
}

export function render() {
  const width = process.stdout.columns || 100;
  const height = process.stdout.rows || 30;
  const lines = [];
  state.buttonRegions = [];

  pushHeader(lines, width);
  if (state.view === "logs" && state.logs) renderLogs(lines, width, height);
  else if (state.view === "tests" && state.tests) renderTests(lines, width, height);
  else if (state.view === "backups" && state.backups) renderBackups(lines, width, height);
  else renderTenants(lines, width, height);

  process.stdout.write(A.clear + lines.slice(0, height).join("\n"));
}
