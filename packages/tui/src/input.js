/**
 * Input decoding: raw stdin bytes → keyboard/mouse events → state changes.
 * Mouse uses SGR reporting (ESC [ < b ; x ; y M/m), enabled by term.js.
 */
import { quit } from "./term.js";
import { state, findButton } from "./state.js";
import { CORE_PROCESS_NAME } from "loopar/bin/pm2.js";
import { render } from "./render.js";
import { run, advanceWizard, submitModal } from "./actions.js";
import { openLogs, closeLogs, reloadLogs } from "./logs.js";
import {
  openTests, closeTests, runAll, runUnit, runIntegration, runSelection, runFailed,
  stopRun, moveCursor, togglePick, scrollDetail,
} from "./tests.js";
import { reloadBackups, moveBackup, backupNow, restoreSelected, deleteSelected } from "./backups.js";

const DOUBLE_CLICK_MS = 400;
let lastClick = { row: -1, t: 0 };

const TAB_ORDER = ["tenants", "logs", "tests"];

/** Tab / Shift+Tab: move through the header tabs in order (wraps around). */
function cycleTab(dir) {
  const cur = Math.max(0, TAB_ORDER.indexOf(state.view));
  for (let step = 1; step < TAB_ORDER.length; step++) {
    const next = TAB_ORDER[(cur + dir * step + TAB_ORDER.length * step) % TAB_ORDER.length];
    handleTabClick(`tab-${next}`);
    return render();
  }
}

function handleTabClick(action) {
  if (action === "tab-tenants") {
    if (state.view === "logs") { closeLogs(); render(); }
    if (state.view === "tests") { closeTests(); render(); }
    return true;
  }
  if (action === "tab-logs") {
    if (state.view !== "logs") {
      if (state.view === "tests") closeTests();
      openLogs(CORE_PROCESS_NAME); // logs live in the core process (same as the Logs button)
    }
    return true;
  }
  if (action === "tab-tests") {
    if (state.view === "logs" || state.logs?.embedded) closeLogs();
    if (state.view !== "tests") openTests();
    return true;
  }
  return false;
}

/** Tenants panel body: "backups" | "logs" (render opens the tenant's log stream). */
function setPanelTab(tab) {
  state.panelTab = tab;
  state.focus = "panel";
  if (tab !== "logs" && state.logs?.embedded) closeLogs();
  return render();
}

/** Scroll the panel's log lines; going up pauses following, End resumes it. */
function scrollPanelLogs(delta) {
  const L = state.logs;
  if (!L?.embedded) return;
  if (delta === Infinity) { L.follow = true; return render(); }
  if (delta < 0) L.follow = false;
  L.scroll = Math.max(0, (L.scroll || 0) + delta); // render clamps and resumes at the bottom
  return render();
}

const GLOBAL_ACTIONS = new Set(["restart", "mode", "new", "quit"]);

const BACKUP_BUTTONS = {
  "backups-new": backupNow,
  "backups-restore": restoreSelected,
  "backups-delete": deleteSelected,
  "backups-reload": reloadBackups,
};

const TEST_BUTTONS = {
  "tests-all": runAll,
  "tests-unit": runUnit,
  "tests-integration": runIntegration,
  "tests-selected": runSelection,
  "tests-failed": runFailed,
  "tests-stop": stopRun,
};

/** Which buttons may be pressed right now (modal modes narrow it down). */
function buttonLive(btn) {
  if (state.mode === "confirm") return btn.action === "confirm-yes" || btn.action === "confirm-no";
  if (state.mode === "create" || state.mode === "destroy") return btn.action === "modal-submit" || btn.action === "modal-cancel";
  if (state.mode !== "list") return false;
  if (btn.disabled) return false; // drawn dimmed (e.g. Start on a tenant that is on)
  if (state.busy && btn.action.startsWith("backups-")) return false;
  return true;
}

/** Run a button/tab after a completed click (press + release on it). */
function activateButton(btn) {
  if (state.mode === "confirm") {
    const c = state.confirm;
    state.mode = "list"; state.confirm = null;
    if (btn.action === "confirm-yes") return c?.onYes?.();
    return c?.onNo ? c.onNo() : render();
  }
  if (btn.action === "modal-submit") return state.mode === "create" ? advanceWizard() : submitModal();
  if (btn.action === "modal-cancel") {
    state.mode = "list"; state.input = ""; state.wizard = null; state.danger = null;
    state.message = "cancelled"; state.messageKind = "info";
    return render();
  }
  if (handleTabClick(btn.action)) return;
  // Server-wide actions (tab row): the same from every view.
  if (GLOBAL_ACTIONS.has(btn.action)) return run(btn.action);
  if (btn.action === "panel-backups") return setPanelTab("backups");
  if (btn.action === "panel-logs") return setPanelTab("logs");
  if (btn.action === "panel-logs-follow") return scrollPanelLogs(Infinity);
  if (BACKUP_BUTTONS[btn.action]) { state.focus = "panel"; return BACKUP_BUTTONS[btn.action](); }
  if (state.view === "tests") return TEST_BUTTONS[btn.action]?.();
  if (state.view === "logs") return;
  return run(btn.action);
}

function handleMouse(seq) {
  // SGR: ESC [ < b ; x ; y (M=press, m=release)
  const m = seq.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/);
  if (!m) return;
  const [, bStr, xStr, yStr, kind] = m;
  const b = Number(bStr), x = Number(xStr), y = Number(yStr);
  const isClick = kind === "M" && b === 0;
  const isRelease = kind === "m" && (b & 3) === 0;

  // Buttons fire on RELEASE over the same button (like a GUI): the press only
  // arms + highlights it, so a click that slips off cancels instead of
  // landing on a neighbour.
  if (isClick) {
    const btn = findButton(x, y);
    if (btn) {
      if (!buttonLive(btn)) return;
      state.pressed = btn.action;
      return render();
    }
  }
  if (isRelease) {
    if (!state.pressed) return;
    const armed = state.pressed;
    state.pressed = null;
    const btn = findButton(x, y);
    if (btn && btn.action === armed && buttonLive(btn)) return activateButton(btn);
    return render();
  }

  if (state.mode !== "list") return; // confirm/text modals: buttons/keyboard only

  // Tests tab: wheel moves the cursor, clicks pick files.
  if (state.view === "tests") {
    const T = state.tests;
    const inDetail = T && T.splitX && x >= T.splitX;
    if (b === 64 || b === 65) {
      if (T) T.focus = inDetail ? "detail" : "list";
      if (inDetail) return scrollDetail(b === 64 ? -3 : 3);
      return moveCursor(b === 64 ? -1 : 1);
    }
    if (!isClick) return;
    if (inDetail) { T.focus = "detail"; return render(); }
    if (T) T.focus = "list";
    const idx = y - (state.testRowStart || 0) + (T?.scroll || 0);
    if (T && y >= state.testRowStart && idx >= 0 && idx < T.files.length && idx - T.scroll < T.listH) {
      const now = Date.now();
      const isDouble = lastClick.row === idx && now - lastClick.t < DOUBLE_CLICK_MS;
      lastClick = { row: idx, t: isDouble ? 0 : now };
      T.cursor = idx;
      if (isDouble) { T.picked.clear(); return runSelection(); }
      return render();
    }
    return;
  }

  // Logs tab: wheel scrolls.
  if (state.view === "logs") {
    const L = state.logs;
    if (b === 64 && L) { L.follow = false; L.scroll = Math.max(0, L.scroll - 3); return render(); }
    if (b === 65 && L) { L.scroll += 3; return render(); } // render clamps; at bottom it just stays
    return;
  }

  // Tenants: the sidebar (tenants) and the panel (the selected tenant's
  // backups) each answer the wheel and clicks in their own area.
  const inPanel = state.panelX && x >= state.panelX - 1;
  if (b === 64 || b === 65) {
    state.focus = inPanel ? "panel" : "sidebar";
    if (inPanel) return state.panelTab === "logs" ? scrollPanelLogs(b === 64 ? -3 : 3) : moveBackup(b === 64 ? -1 : 1);
    return moveTenant(b === 64 ? -1 : 1);
  }
  if (!isClick) return; // left-button press only

  if (inPanel) {
    state.focus = "panel";
    if (state.panelTab === "logs") return render();
    const B = state.backups;
    const node = B && y >= state.backupRowStart && y - state.backupRowStart < B.listH
      ? B.tree?.nodes[y - state.backupRowStart + B.scroll] : null;
    const idx = node?.row ? B.rows.findIndex((r) => r.file === node.row.file) : -1;
    if (idx >= 0) B.cursor = idx;
    return render();
  }

  // Sidebar row: a click only selects. Opening the desk is the panel's URL
  // and its Open button (a double-click here opened tenants by accident).
  state.focus = "sidebar";
  const offset = y - state.rowRegionStart;
  const rowIndex = offset + state.scroll;
  if (offset >= 0 && offset < state.tableH && rowIndex < state.rows.length) state.selected = rowIndex;
  return render();
}

function moveTenant(delta) {
  state.selected = Math.min(Math.max(0, state.selected + delta), Math.max(0, state.rows.length - 1));
  return render();
}

function handleKey(ch, seq) {
  if (state.mode === "confirm") {
    const c = state.confirm;
    const k = (ch || "").toLowerCase();
    if (seq === "\x1b" || ch === "\x03") { // Esc / Ctrl+C → abort
      state.mode = "list"; state.confirm = null;
      state.message = "cancelled"; state.messageKind = "info";
      return render();
    }
    if (k === "y" || ch === "\r") {
      state.mode = "list"; state.confirm = null;
      return c?.onYes?.();
    }
    if (k === "n") {
      state.mode = "list"; state.confirm = null;
      return c?.onNo ? c.onNo() : render();
    }
    return;
  }

  if (state.mode === "create" || state.mode === "destroy") {
    if (seq === "\x1b" || seq === "\x03") { // Esc / Ctrl+C
      state.mode = "list"; state.input = ""; state.wizard = null;
      return render();
    }
    if (ch === "\r") return state.mode === "create" ? advanceWizard() : submitModal();
    if (ch === "\x7f" || ch === "\b") {
      state.input = state.input.slice(0, -1);
      return render();
    }
    if (ch && /^[\x20-\x7e]$/.test(ch)) {
      // Passwords keep their case/symbols; identifiers are lowercased.
      const st = state.wizard?.steps[state.wizard.idx];
      state.input += st?.mask ? ch : ch.toLowerCase();
      return render();
    }
    return;
  }

  // Tab / Shift+Tab cycle through ALL header tabs, from any view.
  if (ch === "\t") return cycleTab(1);
  if (seq === "\x1b[Z") return cycleTab(-1);

  // Tests tab
  if (state.view === "tests") {
    if (seq === "\x1b") { closeTests(); return render(); }
    const T = state.tests;
    const detail = T?.focus === "detail";
    if (seq === "\x1b[D") { if (T) T.focus = "list"; return render(); }   // ← list pane
    if (seq === "\x1b[C") { if (T) T.focus = "detail"; return render(); } // → results pane
    if (seq === "\x1b[A") return detail ? scrollDetail(-1) : moveCursor(-1);
    if (seq === "\x1b[B") return detail ? scrollDetail(1) : moveCursor(1);
    if (seq === "\x1b[H" || seq === "\x1b[1~") return detail ? scrollDetail(-1e9) : moveCursor(-1e9);
    if (seq === "\x1b[F" || seq === "\x1b[4~") return detail ? scrollDetail(1e9) : moveCursor(1e9);
    if (seq === "\x1b[5~") return scrollDetail(-(state.tests?.listH || 10));
    if (seq === "\x1b[6~") return scrollDetail(state.tests?.listH || 10);
    if (seq === "\x1b[15~") return openTests(); // F5: re-scan test files
    if (ch === " ") return togglePick();
    if (ch === "\r") return runSelection();
    switch (ch?.toLowerCase()) {
      case "q": return quit();
      case "\x03": return quit();
      case "j": return detail ? scrollDetail(1) : moveCursor(1);
      case "k": return detail ? scrollDetail(-1) : moveCursor(-1);
      case "a": return runAll();
      case "u": return runUnit();
      case "i": return runIntegration();
      case "f": return runFailed();
      case "x": return stopRun();
    }
    return;
  }

  // Logs tab
  if (state.view === "logs") {
    const L = state.logs;
    if (seq === "\x1b" || ch?.toLowerCase() === "l") {
      closeLogs();
      return render();
    }
    if (seq === "\x1b[A" && L) { L.follow = false; L.scroll = Math.max(0, L.scroll - 1); return render(); }
    if (seq === "\x1b[B" && L) { L.scroll += 1; return render(); } // render clamps
    if (seq === "\x1b[5~" && L) { L.follow = false; L.scroll = Math.max(0, L.scroll - (L.viewH || 10)); return render(); } // PgUp
    if (seq === "\x1b[6~" && L) { L.scroll += (L.viewH || 10); return render(); } // PgDn (render clamps)
    if (seq === "\x1b[15~") return reloadLogs(); // F5
    switch (ch?.toLowerCase()) {
      case "q": return quit();
      case "\x03": return quit(); // Ctrl+C
      case "a": // toggle scope: the core ↔ every pm2 process
        return void openLogs(L?.name ? null : CORE_PROCESS_NAME);
      case "f": if (L) { L.follow = true; render(); } return;
    }
    return;
  }

  // Tenants view: ←/→ move the focus between the sidebar (tenants) and the
  // panel (the selected tenant's backups); ↑↓ and friends follow the focus.
  const panel = state.focus === "panel";
  const logsTab = state.panelTab === "logs";
  const page = panel ? ((logsTab ? state.logs?.viewH : state.backups?.listH) || 10) : (state.tableH || 10);
  const move = (d) => {
    if (!panel) return moveTenant(d);
    if (logsTab) return scrollPanelLogs(d >= 1e9 ? Infinity : d);
    return moveBackup(d);
  };
  if (ch === "1") return setPanelTab("backups");
  if (ch === "2") return setPanelTab("logs");
  switch (seq) {
    case "\x1b[D": state.focus = "sidebar"; return render();
    case "\x1b[C": state.focus = "panel"; return render();
    case "\x1b": if (panel) { state.focus = "sidebar"; return render(); } return;
    case "\x1b[A": return move(-1);
    case "\x1b[B": return move(1);
    case "\x1b[5~": return move(-page); // PgUp
    case "\x1b[6~": return move(page);  // PgDn
    case "\x1b[H": case "\x1b[1~": return move(-1e9); // Home
    case "\x1b[F": case "\x1b[4~": return move(1e9);  // End
    case "\x1b[3~": return state.busy || logsTab ? undefined : deleteSelected(); // Delete → delete the selected backup
    case "\x1b[15~": return Promise.all([run("refresh"), reloadBackups()]); // F5
  }
  if (panel && !logsTab && ch === "\r") return state.busy ? undefined : restoreSelected();
  if (panel && !logsTab && (ch === "\x7f" || ch === "\b")) return state.busy ? undefined : deleteSelected();
  if (ch === "b" || ch === "B") { if (state.busy) return; state.focus = "panel"; return backupNow(); }
  if (ch === "L") return run("logs-all"); // shift+L → merged stream of ALL processes
  if (ch === "T") return openTests(); // shift+T → tests tab (t = stop)
  switch (ch?.toLowerCase()) {
    case "q": return quit();
    case "\x03": return quit(); // Ctrl+C
    case "j": return move(1);
    case "k": return move(-1);
    case "s": return run("start");
    case "t": return run("stop");
    case "r": return run("restart");
    case "o": return run("open");
    case "l": return run("logs");
    case "m": return run("mode");
    case "c": return run("core");
    case "n": return run("new");
    case "d": return run("destroy");
    case "e": return run("reset");
    case "p": return run("control-plane");
    case "\r": return run("refresh");
  }
}

export function onData(buf) {
  // A single chunk can carry several events (fast typing, paste, queued
  // mouse events) — consume it token by token instead of assuming 1 chunk
  // = 1 keypress.
  let s = buf.toString("utf8");
  while (s.length) {
    const mouse = s.match(/^\x1b\[<\d+;\d+;\d+[Mm]/);
    if (mouse) { handleMouse(mouse[0]); s = s.slice(mouse[0].length); continue; }
    const esc = s.match(/^\x1b\[\d*~|^\x1b\[[A-Z]/);
    if (esc) { handleKey(null, esc[0]); s = s.slice(esc[0].length); continue; }
    handleKey(s[0], s[0]);
    s = s.slice(1);
  }
}
