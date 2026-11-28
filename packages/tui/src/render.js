import { A, LOG, pad, link, stripAnsi, displayWidth, clipLine } from "./term.js";
import { state, NO_PM2 } from "./state.js";
import { graphCells, HERE, ROOT } from "./backup-tree.js";
import { showBackupsOf } from "./backups.js";
import { openLogs } from "./logs.js";
import { CORE_PROCESS_NAME } from "loopar/bin/pm2.js";
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
  dark:    { bg: "48;5;236", fg: "37" }, // inactive tab
};
const pill = (label, color = "white") => {
  const c = PILL_BG[color] || PILL_BG.white;
  return `${ESC}[${c.bg};${c.fg}m${label}${A.reset}`;
};

// ─── Buttons ─────────────────────────────────────────────────────────────────
// Buttons and tabs are 3 rows tall (1 when the terminal is short) so they are
// easy mouse targets. Widths come from the RENDERED label (never hand-counted),
// the gap between them is split between neighbours (no dead zones, no
// off-by-one into the next action), and the mouse handler fires on RELEASE
// over the same button — a slipped click cancels instead of hitting another.
// Layout rule, at every level: tabs/info on the left, actions on the right.
export const barRows = (height) => (height >= 22 ? 3 : 1);

// Stable per-process color for the all-logs prefix (red is reserved for
// stderr bodies, so it's not in the palette).
const NAME_COLORS = [A.cyan, A.green, A.yellow, MAGENTA, BLUE, WHITE];
function nameColor(n) {
  let h = 0;
  for (let i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) >>> 0;
  return NAME_COLORS[h % NAME_COLORS.length];
}

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
  return A.gray + "─".repeat(Math.max(0, width)) + A.reset; // edge to edge
}

/** Title + spacer + clickable [Tenants][Logs] tabs + separator (4 lines). */
function pushHeader(lines, width, height) {
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
  const logsLabel = `LOGS${state.logs && !state.logs.embedded ? ` · ${state.logs.name || "all"}` : ""}`;
  const run = state.tests?.handle?.run;
  const testsLabel = !run ? "TESTS"
    : run.status === "running" ? `TESTS · ◐ ${run.counts.pass}✓ ${run.counts.fail}✗`
    : `TESTS · ${run.counts.fail ? `${run.counts.fail}✗` : `${run.counts.pass}✓`}`;
  const tabs = [
    { label: "TENANTS", view: "tenants", action: "tab-tenants" },
    { label: logsLabel, view: "logs", action: "tab-logs" },
    { label: testsLabel, view: "tests", action: "tab-tests" },
  ];
  // Tabs are blocks like the footer buttons: 3 rows (1 on short terminals),
  // inactive ones in a dark chip, the active one in cyan. Row 2 stays empty
  // so the tabs don't merge with the title chip; the 2-col gaps are split
  // between neighbours so there are no dead zones.
  const tall = barRows(height) > 1;
  const y1 = 3, y2 = tall ? 5 : 3;
  const GAP = 2;
  let x = 2; // line starts with one space; x is 1-based
  const tops = [], mids = [];
  tabs.forEach((t, i) => {
    const rendered = `  ${t.label}  `;
    const w = displayWidth(rendered);
    const last = i === tabs.length - 1;
    state.buttonRegions.push({ x1: i === 0 ? x : x - 1, x2: last ? x + w - 1 : x + w, y1, y2, y: y1, action: t.action });
    const active = state.view === t.view;
    const pressed = state.pressed === t.action;
    const paint = (txt) => {
      if (pressed) return `${A.inv}${A.bold}${pill(txt, active ? "cyan" : "gray")}`;
      if (active) return `${A.bold}${pill(txt, "cyan")}`;
      return `${ESC}[48;5;236;37m${txt}${A.reset}`; // dark chip, readable label
    };
    tops.push(paint(" ".repeat(w)));
    mids.push(paint(rendered));
    x += w + GAP;
  });
  const sep = " ".repeat(GAP);
  const tabsW = x - GAP - 1; // last used column

  // Global (server-wide) actions, right-aligned on the tab row — the bottom
  // bar is only for the selected tenant. Same blocks as the tabs; they
  // shrink (padding, then shorter labels) to fit beside the tabs, and move
  // to the title row as small chips when even that doesn't fit.
  const titleRow = lines.length - 1; // index of the title line
  const globals = pushGlobalActions(lines, { width, y1, y2, fromCol: tabsW + 1, titleRow });
  lines.push(globals.spacer || "");
  if (tall) lines.push(" " + tops.join(sep) + globals.top);
  lines.push(" " + mids.join(sep) + globals.mid);
  if (tall) lines.push(" " + tops.join(sep) + globals.top);
  lines.push(hr(width));
}

// The Mode button names where it switches TO (dev → Prod, prod → Dev).
const globalActions = () => {
  let toProd = true;
  try { toProd = coreEnv() !== "production"; } catch { /* no core config yet */ }
  const mode = toProd ? ` ⇄ ${U}P${UO}rod ` : ` ⇄ ${U}D${UO}ev `;
  return [
    { long: ` ↻ ${U}R${UO}estart `, short: ` ↻ ${U}R${UO}estart `, color: "cyan", action: "restart" },
    { long: mode, short: mode, color: "magenta", action: "mode" },
    { long: ` + ${U}N${UO}ew `, short: ` + ${U}N${UO}ew `, color: "blue", action: "new" },
    { long: ` ${U}Q${UO}uit `, short: ` ${U}Q${UO}uit `, color: "gray", action: "quit" },
  ];
};

/**
 * Lay out the global actions after the tabs (which end at column
 * `fromCol`). Returns the strings to append to the tab rows ({ top, mid })
 * and registers their click regions. Fallbacks for narrow terminals: chips
 * appended to the title row (lines[titleRow]), then chips on the empty row
 * below it (returned as `spacer`).
 */
function pushGlobalActions(lines, { width, y1, y2, fromCol, titleRow }) {
  const GAP = 2;
  const paint = (a, txt) => state.pressed === a.action ? `${A.inv}${A.bold}${pill(txt, a.color)}` : pill(txt, a.color);
  const actionsNow = globalActions();
  const build = (key, sidePad) => actionsNow.map((a) => {
    const label = `${" ".repeat(sidePad)}${a[key]}${" ".repeat(sidePad)}`;
    return { ...a, label, w: displayWidth(stripAnsi(label)) };
  });
  const totalW = (items) => items.reduce((n, a) => n + a.w, 0) + GAP * (items.length - 1);
  const right = width - 1; // keep one free column at the right edge
  const place = (items, start, ya, yb) => {
    let x = start;
    items.forEach((a, i) => {
      const last = i === items.length - 1;
      state.buttonRegions.push({ x1: i === 0 ? x : x - 1, x2: last ? x + a.w - 1 : x + a.w, y1: ya, y2: yb, y: ya, action: a.action });
      x += a.w + GAP;
    });
  };

  for (const [key, pad] of [["long", 1], ["long", 0], ["short", 1], ["short", 0]]) {
    const items = build(key, pad);
    const start = right - totalW(items) + 1; // 1-based first column
    if (start < fromCol + 4) continue; // keep a clear gap after the tabs
    place(items, start, y1, y2);
    const lead = " ".repeat(start - fromCol); // tab rows end at column fromCol - 1
    const sep = " ".repeat(GAP);
    return {
      top: lead + items.map((a) => paint(a, " ".repeat(a.w))).join(sep),
      mid: lead + items.map((a) => paint(a, a.label)).join(sep),
    };
  }

  // Fallback: small one-row chips on the title row, right-aligned.
  const items = build("short", 0);
  const titleW = displayWidth(stripAnsi(lines[titleRow] || ""));
  const start = right - totalW(items) + 1;
  const chips = items.map((a) => paint(a, a.label)).join(" ".repeat(GAP));
  if (start > titleW + 2) {
    place(items, start, titleRow + 1, titleRow + 1);
    lines[titleRow] += " ".repeat(start - titleW - 1) + chips;
    return { top: "", mid: "" };
  }
  // Last resort: the empty row between the title and the tabs.
  if (start >= 2) {
    place(items, start, titleRow + 2, titleRow + 2);
    return { top: "", mid: "", spacer: " ".repeat(start - 1) + chips };
  }
  return { top: "", mid: "" }; // the hotkeys (r m n q) still work
}

// ─── Tenants: sidebar + panel ────────────────────────────────────────────────
//
//   sidebar (tenants)  │ heading: NAME · status · URL            (the tenant)
//                      │ [Start] [Stop] [Open] [Control plane] [Reset] [Destroy]
//                      │ ─────────────────────────────────────────
//                      │ BACKUPS · n · where        [+ Backup] [↺ Restore] [× Delete]
//                      │ tree of backups                          (its children)
//
// Every action sits next to what it acts on: server-wide ones on the tab
// row, the tenant's in the panel heading, the backups' on their section.
// ←/→ moves the focus between the sidebar and the panel (↑↓ follow it).

/**
 * A row of buttons at an absolute position (1-based x0/y0). Returns its text
 * rows (3 when tall, else 1) and registers the click regions — unless `dry`
 * (measure only). Fits `maxW` by dropping side padding, then the gap.
 */
function buttonRows(buttons, { x0 = 1, y0 = 1, tall, maxW = Infinity, dry = false }) {
  const base = buttons.reduce((n, b) => n + displayWidth(stripAnsi(b.label)), 0);
  const need = (p, g) => base + buttons.length * p * 2 + (buttons.length - 1) * g;
  const [sidePad, gap] = [[1, 2], [0, 2], [0, 1]].find(([p, g]) => need(p, g) <= maxW) || [0, 1];
  const side = " ".repeat(sidePad);
  const y1 = y0, y2 = y0 + (tall ? 2 : 0);
  let x = x0;
  const items = buttons.map((b, i) => {
    const label = `${side}${b.label}${side}`;
    const w = displayWidth(stripAnsi(label));
    if (!dry) {
      const first = i === 0, last = i === buttons.length - 1;
      state.buttonRegions.push({ x1: first || gap < 2 ? x : x - 1, x2: last ? x + w - 1 : x + w, y1, y2, y: y1, action: b.action, disabled: !!b.disabled });
    }
    x += w + gap;
    const paint = (t) => b.disabled ? `${ESC}[48;5;236;90m${t}${A.reset}`
      : state.pressed === b.action ? `${A.inv}${A.bold}${pill(t, b.color)}` : pill(t, b.color);
    return { mid: paint(label), blank: paint(" ".repeat(w)) };
  });
  const sep = " ".repeat(gap);
  const mid = items.map((i) => i.mid).join(sep);
  const blank = items.map((i) => i.blank).join(sep);
  return { rows: tall ? [blank, mid, blank] : [mid], width: x - gap - x0 };
}

/**
 * One "head" of a container, the same shape at every level: tabs or info on
 * the left, the container's actions right-aligned (like the top bar: tabs |
 * server actions). `left` is its rows (3 when tall, else 1) and `leftW` their
 * width. Returns the composed rows; registers the buttons' click regions.
 */
function headRows({ left, leftW, buttons, x0, y0, width, tall }) {
  const n = tall ? 3 : 1;
  const room = width - leftW - 2;
  const measured = buttonRows(buttons, { tall, maxW: room, dry: true });
  const bx0 = x0 + Math.max(leftW + 2, width - measured.width);
  const btns = buttonRows(buttons, { x0: bx0, y0, tall, maxW: room });
  return Array.from({ length: n }, (_, i) => padCells(left[i] ?? "", bx0 - x0) + (btns.rows[i] ?? ""));
}

/** Info text on the label row of a head (the middle one when tall). */
const infoRows = (text, tall) => (tall ? ["", text, ""] : [text]);

function statusLabel(st) {
  const m = statusMeta(st);
  const word = st === "online" ? "on" : st === "stopped" ? "off" : st;
  return `${m.color}${m.dot} ${word}${A.reset}`;
}

function renderTenants(lines, width, height) {
  const tall = barRows(height) > 1;
  const bodyTop = lines.length + 1;                       // 1-based row of the first body line
  const bodyH = Math.max(4, height - lines.length - 2);   // body + hr + status line
  const focusPanel = state.focus === "panel";
  const sel = state.rows[state.selected];
  if (sel) showBackupsOf(sel.name);

  // ── Sidebar ──
  const longest = state.rows.reduce((n, r) => Math.max(n, r.name.length), 7);
  const sbW = Math.min(30, Math.max(20, longest + 8));
  const left = [];
  left.push(`  ${A.bold}${A.gray}TENANTS${A.reset} ${A.dim}${state.rows.length}${A.reset}`);
  const listH = Math.max(1, bodyH - 2); // title + legend
  state.tableH = listH;
  state.rowRegionStart = bodyTop + 1;
  state.sidebarW = sbW;
  if (state.selected < state.scroll) state.scroll = state.selected;
  if (state.selected >= state.scroll + listH) state.scroll = state.selected - listH + 1;
  for (let i = 0; i < listH; i++) {
    const row = state.rows[state.scroll + i];
    if (!row) { left.push(i === 0 && !state.rows.length ? `  ${A.dim}none yet — + New tenant${A.reset}` : ""); continue; }
    const isSel = state.scroll + i === state.selected;
    const m = statusMeta(row.status);
    const nameW = sbW - 7;
    const name = (row.name.length > nameW ? row.name.slice(0, nameW - 1) + "…" : row.name).toUpperCase().padEnd(nameW);
    const cp = row.controlPlane ? "◆" : " ";
    if (isSel && !focusPanel) left.push(`${A.inv}❯ ${m.dot} ${A.bold}${name}${A.reset}${A.inv} ${cp} ${A.reset}`);
    else if (isSel) left.push(`${A.cyan}❯${A.reset} ${m.color}${m.dot}${A.reset} ${A.bold}${A.under}${name}${A.reset} ${A.magenta}${cp}${A.reset}`);
    else left.push(`  ${m.color}${m.dot}${A.reset} ${name} ${A.magenta}${cp}${A.reset}`);
  }
  const more = state.rows.length > listH ? ` ${A.dim}${state.scroll + 1}–${Math.min(state.scroll + listH, state.rows.length)}/${state.rows.length}${A.reset}` : "";
  left.push(`  ${A.green}▶${A.reset}${A.dim}on ${A.reset}${A.red}■${A.reset}${A.dim}off ${A.reset}${A.magenta}◆${A.reset}${A.dim}cp${A.reset}${more}`);

  // ── Panel ──
  const px0 = sbW + 3;                 // 1-based column where the panel starts
  const panelW = Math.max(20, width - px0);
  state.panelX = px0;
  const right = renderTenantPanel(sel, { px0, panelW, bodyTop, bodyH, tall });

  const sepColor = focusPanel ? A.cyan : A.gray;
  for (let i = 0; i < bodyH; i++) {
    lines.push(`${padCells(left[i] || "", sbW)}${sepColor}│${A.reset} ${right[i] || ""}`);
  }
  lines.push(hr(width));

  const icon = state.messageKind === "error" ? `${A.red}✗` : state.messageKind === "ok" ? `${A.green}✓` : `${A.gray}·`;
  const msgColor = state.messageKind === "error" ? A.red : state.messageKind === "ok" ? A.green : A.dim;
  const hint = state.panelTab === "logs"
    ? `${A.dim}←→ sidebar/panel · ↑↓ scroll · End follow · 1 backups · 2 logs${A.reset}`
    : `${A.dim}←→ sidebar/panel · ↑↓ move · b back up · ⏎ restore · ⌫ delete · 1 backups · 2 logs${A.reset}`;
  lines.push(state.busy
    ? ` ${A.yellow}◐ ${state.message || "working…"}${A.reset}`
    : (state.message ? ` ${icon} ${msgColor}${state.message}${A.reset}` : ` ${hint}`));
}

/** The panel's lines (exactly bodyH of them, may be shorter): heading, actions, backups. */
function renderTenantPanel(sel, { px0, panelW, bodyTop, bodyH, tall }) {
  const out = [];
  const y = () => bodyTop + out.length; // 1-based row of the next line
  if (!sel) {
    out.push(`${A.dim}No tenant selected.${A.reset}`);
    return out;
  }

  // Heading: identity of the tenant; the URL opens it.
  const name = `${A.bold}${sel.name.toUpperCase()}${A.reset}`;
  const head = `${name}  ${statusLabel(sel.status)}${sel.controlPlane ? `  ${A.magenta}◆ control plane${A.reset}` : ""}  `;
  const urlX = px0 + displayWidth(stripAnsi(head));
  const urlTxt = sel.url ? `${sel.url} ↗` : "";
  if (sel.url) state.buttonRegions.push({ x1: urlX, x2: urlX + displayWidth(urlTxt) - 1, y1: y(), y2: y(), y: y(), action: "open" });
  out.push(head + (sel.url ? `${A.cyan}${A.under}${link(sel.url, sel.url)}${A.reset}${A.cyan} ↗${A.reset}` : ""));
  if (tall) out.push("");

  // Tenant head: its tabs (children) on the left, its actions on the right.
  const tab = state.panelTab === "logs" ? "logs" : "backups";
  const b = state.backups && state.backups.tenant === sel.name ? state.backups : null;
  const rows = b?.rows || [];
  const busy = state.busy;
  const online = sel.status === "online";
  const tabBtns = buttonRows([
    { label: ` ${U}1${UO} Backups ${rows.length} `, color: tab === "backups" ? "cyan" : "dark", action: "panel-backups" },
    { label: ` ${U}2${UO} Logs `, color: tab === "logs" ? "cyan" : "dark", action: "panel-logs" },
  ], { x0: px0, y0: y(), tall, maxW: Math.floor(panelW / 2) });
  out.push(...headRows({
    left: tabBtns.rows, leftW: tabBtns.width, x0: px0, y0: y(), width: panelW, tall,
    buttons: [
      // One switch: what it does now (on → Stop, off → Start).
      online
        ? { label: ` ■ S${U}t${UO}op `, color: "yellow", action: "stop" }
        : { label: ` ▶ ${U}S${UO}tart `, color: "green", action: "start" },
      { label: ` ◆ Control ${U}p${UO}lane `, color: "magenta", action: "control-plane" },
      { label: ` ⟲ R${U}e${UO}set `, color: "yellow", action: "reset" },
      { label: ` × ${U}D${UO}estroy `, color: "red", action: "destroy" },
    ],
  }));
  out.push(`${A.gray}${"─".repeat(panelW)}${A.reset}`);

  // Container head: what the active tab shows on the left, its actions right.
  const L = state.logs?.embedded && state.logs.tenant === sel.name ? state.logs : null;
  const info = tab === "backups"
    ? `${A.dim}${rows.length} backup(s) · ${b?.destination ? `this server + ${b.destination}` : "this server only"}${b?.loading ? " · loading…" : ""}${A.reset}`
    : (!L ? `${A.dim}loading…${A.reset}`
      : L.follow ? `${A.green}● following${A.reset}` : `${A.yellow}❚❚ paused${A.dim} · End follows${A.reset}`);
  out.push(...headRows({
    left: infoRows(info, tall), leftW: displayWidth(stripAnsi(info)), x0: px0, y0: y(), width: panelW, tall,
    buttons: tab === "backups"
      ? [
        { label: ` + ${U}B${UO}ack up `, color: "green", action: "backups-new", disabled: busy },
        { label: ` ↺ Restore ⏎ `, color: "yellow", action: "backups-restore", disabled: busy || !rows.length },
        { label: ` × Delete ⌫ `, color: "red", action: "backups-delete", disabled: busy || !rows.length },
      ]
      : [
        { label: ` ⤓ Follow `, color: "green", action: "panel-logs-follow", disabled: !L || L.follow },
        { label: ` ≣ Server logs `, color: "white", action: "tab-logs" },
      ],
  }));

  if (tab === "logs") return renderPanelLogs(out, sel, L, { panelW, bodyH, bodyTop });

  // Tree of backups.
  const tree = b?.tree || { nodes: [], width: 1 };
  const lineage = b?.lineage || { lit: new Set(), current: null };
  const graphW = Math.max(2, tree.width * 2 + 1);
  const showWhere = panelW >= graphW + 17 + 13 + 10 + 14 + 12;
  const showFile = panelW >= graphW + 17 + 13 + 10 + (showWhere ? 14 : 0) + 24;
  out.push(`${" ".repeat(graphW)}${A.bold}${A.gray}${pad("DATE", 18)}${pad("KIND", 13)}${pad("SIZE", 10)}${showWhere ? pad("WHERE", 14) : ""}${showFile ? "FILE" : ""}${A.reset}`);

  const listH = Math.max(1, bodyH - out.length);
  if (b) b.listH = listH;
  state.backupRowStart = y();
  if (!b || !rows.length) {
    out.push(`${A.dim}${b?.loading ? "loading…" : "No backups yet — + Back up (b) makes one."}${A.reset}`);
    return out;
  }
  const nodes = tree.nodes;
  const curRow = b.cursor + 1; // row 0 is "You are here"
  if (curRow - 1 < b.scroll) b.scroll = Math.max(0, curRow - 1);
  if (curRow >= b.scroll + listH) b.scroll = curRow - listH + 1;
  b.scroll = Math.min(b.scroll, Math.max(0, nodes.length - listH));
  const fileW = Math.max(8, panelW - graphW - 18 - 13 - 10 - (showWhere ? 14 : 0) - 1);
  const current = lineage.current ? rows.find((r) => r.file === lineage.current) : null;
  const focusPanel = state.focus === "panel";

  for (let i = 0; i < listH; i++) {
    const n = nodes[b.scroll + i];
    if (!n) break;
    const graph = padCells(graphCells(n, tree.width, lineage), graphW);
    if (n.id === HERE) {
      const from = current ? `${A.dim}· from the ${current.kind} backup of ${fmtWhen(current.date)}${A.reset}` : `${A.dim}· current state${A.reset}`;
      out.push(`${graph}${A.bold}${A.cyan}You are here${A.reset} ${from}`);
      continue;
    }
    if (n.id === ROOT) { out.push(`${graph}${A.dim}${sel.name} · origin${A.reset}`); continue; }
    const r = n.row;
    const isCur = rows[b.cursor]?.file === r.file;
    const isHead = r.file === lineage.current;
    const loc = [r.local ? "local" : null, r.remote ? "remote" : null].filter(Boolean).join("+") + (r.encrypted ? " ·enc" : "");
    const fileTxt = !showFile ? "" : r.file.length > fileW ? r.file.slice(0, fileW - 1) + "…" : r.file;
    const whereTxt = showWhere ? pad(loc, 14) : "";
    const cols = `${pad(fmtWhen(r.date), 18)}${pad(r.kind, 13)}${pad(fmtBytes(r.size), 10)}${whereTxt}${fileTxt}`;
    if (isCur && focusPanel) out.push(`${graph}${A.inv}${cols}${A.reset}`);
    else if (isCur) out.push(`${graph}${A.under}${cols}${A.reset}`);
    else if (isHead) out.push(`${graph}${A.bold}${A.cyan}${pad(fmtWhen(r.date), 18)}${pad(r.kind, 13)}${A.reset}${pad(fmtBytes(r.size), 10)}${A.dim}${whereTxt}${fileTxt}${A.reset}`);
    else out.push(`${graph}${pad(fmtWhen(r.date), 18)}${KIND_COLOR[r.kind] || ""}${pad(r.kind, 13)}${A.reset}${pad(fmtBytes(r.size), 10)}${A.dim}${whereTxt}${fileTxt}${A.reset}`);
  }
  return out;
}

let pendingLogs = null;

/** Open (or re-point) the embedded log stream at `tenant` — once, after this frame. */
function wantTenantLogs(tenant) {
  if (pendingLogs === tenant) return;
  pendingLogs = tenant;
  setImmediate(() => {
    pendingLogs = null;
    const still = state.view === "tenants" && state.panelTab === "logs" && state.rows[state.selected]?.name === tenant;
    if (still && !(state.logs?.embedded && state.logs.tenant === tenant)) openLogs(CORE_PROCESS_NAME, { tenant, embedded: true });
  });
}

/** The tenant's own log lines (the core's logs filtered by its "[tenant]" stamp). */
function renderPanelLogs(out, sel, L, { panelW, bodyH, bodyTop }) {
  if (!L) { wantTenantLogs(sel.name); out.push(`${A.dim}loading…${A.reset}`); return out; }
  const viewH = Math.max(1, bodyH - out.length);
  L.viewH = viewH;
  state.panelLogRowStart = bodyTop + out.length;
  const total = L.lines.length;
  const maxStart = Math.max(0, total - viewH);
  if (L.follow) L.scroll = maxStart;
  else L.scroll = Math.min(Math.max(0, L.scroll), maxStart);
  if (!L.follow && L.scroll >= maxStart) L.follow = true; // back at the bottom
  for (const e of L.lines.slice(L.scroll, L.scroll + viewH)) {
    if (e.s === "meta") { out.push(`${A.dim}${e.text}${A.reset}`); continue; }
    const time = e.at ? `${A.dim}${new Date(e.at).toTimeString().slice(0, 8)}${A.reset} ` : "";
    const room = panelW - (e.at ? 9 : 0);
    const plain = stripAnsi(e.text);
    out.push(`${time}${paintLog(plain, e.s)}${plain.length > room ? plain.slice(0, room - 1) + "…" : plain}${A.reset}`);
  }
  return out;
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
  const viewH = Math.max(3, height - 7 - (barRows(height) > 1 ? 2 : 0)); // logs: tall tabs, no button bar
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
    // "[tenant] " stamp (core/server/tenant-log-prefix.js) in the tenant's color.
    const stamp = e.t ? `[${e.t}] ` : "";
    if (stamp && plain.startsWith(stamp)) {
      lines.push(` ${time}${pfx}${nameColor(e.t)}[${e.t}]${A.reset} ${color}${body.slice(stamp.length)}${A.reset}`);
      continue;
    }
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
    ? `  ${A.dim}› ${cut(`${run.current.file} › ${run.current.name}`, Math.max(10, width - 60))}${A.reset}`
    : "";
  const followChip = run?.status === "running"
    ? (t.follow !== false ? `  ${A.green}● following${A.reset}` : `  ${A.yellow}❚❚ paused${A.dim} · scroll to the bottom to follow${A.reset}`)
    : "";
  // Tests head: the run's status on the left, the run actions on the right.
  const tall = barRows(height) > 1;
  const status = ` ${chip}${counts}${followChip}${current}`;
  lines.push(...headRows({
    left: infoRows(status, tall), leftW: displayWidth(stripAnsi(status)), x0: 1, y0: lines.length + 1, width: width - 1, tall,
    buttons: [
      { label: ` ▶ ${U}A${UO}ll `, color: "green", action: "tests-all" },
      { label: ` ${U}U${UO}nit `, color: "cyan", action: "tests-unit" },
      { label: ` ${U}I${UO}ntegration `, color: "cyan", action: "tests-integration" },
      { label: ` ⏎ Picked${t.picked.size ? ` (${t.picked.size})` : ""} `, color: "white", action: "tests-selected", disabled: !t.picked.size && !t.files.length },
      { label: ` ↻ ${U}F${UO}ailed `, color: "yellow", action: "tests-failed", disabled: !run?.counts?.fail },
      { label: ` ■ Stop ${U}x${UO} `, color: "red", action: "tests-stop", disabled: run?.status !== "running" },
    ],
  }));
  lines.push(hr(width));

  // body + rule + status line below it
  const bodyH = Math.max(3, height - lines.length - 2);
  t.listH = bodyH;
  const leftW = Math.min(52, Math.max(30, Math.floor(width * 0.4)));
  const rightW = Math.max(10, width - leftW - 4);

  if (t.cursor < t.scroll) t.scroll = t.cursor;
  if (t.cursor >= t.scroll + bodyH) t.scroll = t.cursor - bodyH + 1;
  const shown = t.files.slice(t.scroll, t.scroll + bodyH);
  state.testRowStart = lines.length + 1; // 1-based terminal row of the first file

  const detail = testDetailLines(run, t.files.length);
  const maxScroll = Math.max(0, detail.length - bodyH);
  // Follow the run like `tail -f`: while it runs, the results pane stays on
  // the newest output. Scrolling up pauses it; reaching the bottom again (or
  // a new run) resumes. When the run ends the pane stays where it is.
  const runId = run?.startedAt || null;
  if (runId !== t.followRun) { t.followRun = runId; t.follow = true; }
  const running = run?.status === "running";
  if (t.follow && running) t.detailScroll = maxScroll;
  t.detailScroll = Math.min(t.detailScroll, maxScroll);
  if (running && t.detailScroll >= maxScroll) t.follow = true;
  const right = detail.slice(t.detailScroll, t.detailScroll + bodyH);

  // Right pane: the separator doubles as its scrollbar; ←/→ (or the mouse
  // wheel over a pane) choose which pane ↑↓ / wheel scroll.
  t.splitX = leftW + 3; // 1-based column of the separator
  const focusDetail = t.focus === "detail";
  const thumbH = maxScroll ? Math.max(1, Math.round(bodyH * bodyH / detail.length)) : 0;
  const thumbY = maxScroll ? Math.round((t.detailScroll / maxScroll) * (bodyH - thumbH)) : 0;
  const sepColor = focusDetail ? A.cyan : A.gray;

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
      const curOn = isCur && !focusDetail ? A.inv : "";
      const body2 = focusDetail ? body.replace(A.inv, A.under) : body;
      left = isCur ? `${curOn}❯ ${A.reset}${body2}` : `  ${body}`;
    }
    const r = right[i];
    const rText = r ? `${r.color}${cut(r.text, rightW)}${A.reset}` : "";
    const thumb = thumbH && i >= thumbY && i < thumbY + thumbH;
    lines.push(` ${left} ${thumb ? `${focusDetail ? A.cyan : A.reset}┃` : `${sepColor}│`}${A.reset} ${rText}`);
  }

  lines.push(hr(width));

  const icon = state.messageKind === "error" ? `${A.red}✗` : state.messageKind === "ok" ? `${A.green}✓` : `${A.gray}·`;
  const msgColor = state.messageKind === "error" ? A.red : state.messageKind === "ok" ? A.green : A.dim;
  lines.push(state.message
    ? ` ${icon} ${msgColor}${state.message}${A.reset}`
    : ` ${A.dim}←→ pane · ↑↓ scroll · space pick · ⏎ run picked${A.reset}`);
}

// ─── Backups (shared formatting) ─────────────────────────────────────────────

const KIND_COLOR = { scheduled: A.cyan, manual: MAGENTA, "pre-update": A.yellow, "pre-restore": A.yellow, uploaded: A.gray };
const fmtBytes = (n) => (n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round((n || 0) / 1024))} KB`);
const fmtWhen = (d) => {
  const x = new Date(d);
  const p = (v) => String(v).padStart(2, "0");
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())} ${p(x.getHours())}:${p(x.getMinutes())}`;
};


// ─── Modal overlay ───────────────────────────────────────────────────────────
// Confirm / name-to-confirm / new-tenant wizard render as a centred box on
// top of the frame (the frame behind is dimmed). The box owns the mouse while
// it is open: its buttons are the only click regions.

function wrapText(text, w) {
  const out = [];
  for (const para of String(text).split("\n")) {
    let cur = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (!cur) cur = word;
      else if (displayWidth(cur) + 1 + displayWidth(word) <= w) cur += " " + word;
      else { out.push(cur); cur = word; }
      while (displayWidth(cur) > w) { out.push(cur.slice(0, w)); cur = cur.slice(w); }
    }
    out.push(cur);
  }
  return out;
}

/** Slice plain text by terminal cells [from, to). */
function sliceCells(plain, from, to = Infinity) {
  let out = "", col = 0;
  for (const ch of plain) {
    const w = displayWidth(ch);
    if (col >= from && col + w <= to) out += ch;
    col += w;
    if (col >= to) break;
  }
  return out;
}

const padCells = (s, n) => s + " ".repeat(Math.max(0, n - displayWidth(stripAnsi(s))));

/** Text field: gray bar, › prompt, block cursor; shows the tail when long. */
function inputField(value, w) {
  const room = Math.max(1, w - 4);
  const shown = displayWidth(value) > room ? "…" + value.slice(-(room - 1)) : value;
  const rest = Math.max(0, w - 3 - displayWidth(shown) - 1);
  return `${ESC}[100;97m › ${shown}${ESC}[7m ${ESC}[27m${" ".repeat(rest)}${A.reset}`;
}

function modalSpec() {
  if (state.mode === "confirm" && state.confirm) {
    return {
      title: state.confirm.title || "Confirm", border: A.yellow,
      body: state.confirm.question,
      buttons: [
        { label: ` ✓ ${U}Y${UO}es `, color: "green", action: "confirm-yes" },
        { label: ` ✗ ${U}N${UO}o `, color: "red", action: "confirm-no" },
      ],
      hint: "Y / Enter yes · N no · Esc cancel",
    };
  }
  if (state.mode === "destroy") {
    const target = state.rows[state.selected]?.name || "";
    const reset = state.danger === "reset";
    const matches = state.input.trim() === target.toLowerCase();
    return {
      title: reset ? "⚠ Reset tenant" : "⚠ Destroy tenant", border: A.red,
      body: reset
        ? `Drops ${target}'s database. The tenant stays and reopens the setup wizard.`
        : `Drops the database and deletes sites/${target} from disk. This cannot be undone.`,
      inputLabel: `Type ${A.reset}${A.bold}${target}${A.reset}${A.dim} to confirm`,
      input: state.input,
      buttons: [
        { label: reset ? " ⟲ Reset " : " × Destroy ", color: matches ? "red" : "gray", action: "modal-submit" },
        { label: " Cancel ", color: "gray", action: "modal-cancel" },
      ],
      hint: "Enter confirm · Esc cancel",
    };
  }
  if (state.mode === "create" && state.wizard) {
    const w = state.wizard;
    const st = w.steps[w.idx];
    const last = w.idx === w.steps.length - 1;
    const dots = w.steps.map((_, i) =>
      i < w.idx ? `${A.green}●${A.reset}` : i === w.idx ? `${A.cyan}●${A.reset}` : `${A.gray}○${A.reset}`
    ).join(" ");
    const border = { cyan: A.cyan, yellow: A.yellow, red: A.red, green: A.green }[w.border || "cyan"] || A.cyan;
    return {
      title: w.title, border,
      body: w.body || "",
      // Progress dots only when there is more than one step.
      bodyAnsi: w.steps.length > 1 ? `${dots}  ${A.dim}step ${w.idx + 1} of ${w.steps.length}${A.reset}` : "",
      inputLabel: st.label,
      input: st.mask ? "*".repeat(state.input.length) : state.input,
      error: state.messageKind === "error" ? state.message : "",
      buttons: [
        last
          ? { label: w.submitLabel || " ✓ Create ", color: w.submitColor || "green", action: "modal-submit" }
          : { label: " → Next ", color: "blue", action: "modal-submit" },
        { label: " Cancel ", color: "gray", action: "modal-cancel" },
      ],
      hint: `Enter ${last ? "confirm" : "next"} · Esc cancel`,
    };
  }
  return null;
}

function drawModal(lines, width, height) {
  const spec = modalSpec();
  if (!spec) return;
  state.buttonRegions = []; // the box owns the mouse

  const boxW = Math.min(width - 2, 64);
  const inner = boxW - 4;
  const content = [""];
  if (spec.body) for (const l of wrapText(spec.body, inner)) content.push(`${A.bold}${l}${A.reset}`);
  if (spec.bodyAnsi) content.push(spec.bodyAnsi);
  if (spec.input !== undefined) {
    content.push("");
    // Plain labels wrap inside the box; ANSI-styled ones are short by design.
    const label = String(spec.inputLabel);
    if (stripAnsi(label) === label) for (const l of wrapText(label, inner)) content.push(`${A.dim}${l}${A.reset}`);
    else content.push(`${A.dim}${label}${A.reset}`);
    content.push(inputField(spec.input, inner));
  }
  if (spec.error) {
    content.push("");
    for (const l of wrapText(`✗ ${spec.error}`, inner)) content.push(`${A.red}${l}${A.reset}`);
  }
  content.push("");

  // Buttons: 3-row pills centred in the box.
  const GAP = 3;
  const btns = spec.buttons.map((b) => {
    const label = ` ${b.label} `;
    return { ...b, label, w: displayWidth(stripAnsi(label)) };
  });
  const total = btns.reduce((n, b) => n + b.w, 0) + GAP * (btns.length - 1);
  const btnRow = content.length; // index in content of the first pill row
  const lead = Math.max(0, Math.floor((inner - total) / 2));
  const paint = (b, txt) => state.pressed === b.action ? `${A.inv}${A.bold}${pill(txt, b.color)}` : pill(txt, b.color);
  const rowOf = (mid) => " ".repeat(lead) + btns.map((b) => paint(b, mid ? b.label : " ".repeat(b.w))).join(" ".repeat(GAP));
  content.push(rowOf(false), rowOf(true), rowOf(false));
  content.push("");
  content.push(`${A.dim}${padCells("", Math.max(0, Math.floor((inner - displayWidth(spec.hint)) / 2)))}${spec.hint}${A.reset}`);

  const boxH = content.length + 2;
  const x0 = Math.max(0, Math.floor((width - boxW) / 2)); // 0-based column
  const y0 = Math.max(0, Math.floor((height - boxH) / 2)); // 0-based row

  // Click regions (1-based terminal coords). Gaps split between neighbours.
  let cx = x0 + 2 + lead + 1;
  btns.forEach((b, i) => {
    const half = Math.floor(GAP / 2);
    state.buttonRegions.push({
      x1: i === 0 ? cx : cx - half,
      x2: i === btns.length - 1 ? cx + b.w - 1 : cx + b.w - 1 + (GAP - half),
      y1: y0 + 1 + btnRow + 1, y2: y0 + 1 + btnRow + 3, y: y0 + 1 + btnRow + 1,
      action: b.action,
    });
    cx += b.w + GAP;
  });

  const bc = spec.border;
  const tw = displayWidth(spec.title);
  const box = [
    `${bc}╭─ ${A.reset}${A.bold}${spec.title}${A.reset}${bc} ${"─".repeat(Math.max(0, boxW - 5 - tw))}╮${A.reset}`,
    ...content.map((c) => `${bc}│${A.reset} ${padCells(c, inner)} ${bc}│${A.reset}`),
    `${bc}╰${"─".repeat(boxW - 2)}╯${A.reset}`,
  ];

  // Composite: dim the whole frame, then lay the box over its rows.
  while (lines.length < height) lines.push("");
  for (let i = 0; i < height; i++) {
    const plain = stripAnsi(lines[i] || "");
    const bi = i - y0;
    if (bi >= 0 && bi < box.length) {
      const left = padCells(sliceCells(plain, 0, x0), x0);
      const right = sliceCells(plain, x0 + boxW);
      lines[i] = `${A.gray}${A.dim}${left}${A.reset}${box[bi]}${A.gray}${A.dim}${right}${A.reset}`;
    } else {
      lines[i] = `${A.gray}${A.dim}${plain}${A.reset}`;
    }
  }
}

export function render() {
  const width = process.stdout.columns || 100;
  const height = process.stdout.rows || 30;
  const lines = [];
  state.buttonRegions = [];

  pushHeader(lines, width, height);
  if (state.view === "logs" && state.logs) renderLogs(lines, width, height);
  else if (state.view === "tests" && state.tests) renderTests(lines, width, height);
  else renderTenants(lines, width, height);
  drawModal(lines, width, height);

  process.stdout.write(A.clear + lines.slice(0, height).map((l) => clipLine(l, width)).join("\n"));
}
