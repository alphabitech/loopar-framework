/**
 * Input decoding: raw stdin bytes → keyboard/mouse events → state changes.
 * Mouse uses SGR reporting (ESC [ < b ; x ; y M/m), enabled by term.js.
 */
import { quit } from "./term.js";
import { state } from "./state.js";
import { render } from "./render.js";
import { run, advanceWizard, submitModal } from "./actions.js";
import { openLogs, closeLogs, reloadLogs } from "./logs.js";
import {
  openTests, closeTests, runAll, runUnit, runIntegration, runSelection, runFailed,
  stopRun, moveCursor, togglePick, scrollDetail,
} from "./tests.js";
import { openBackups, closeBackups, reloadBackups, moveBackup, backupNow, restoreSelected, deleteSelected } from "./backups.js";

const DOUBLE_CLICK_MS = 400;
let lastClick = { row: -1, t: 0 };

function handleTabClick(action) {
  if (action === "tab-tenants") {
    if (state.view === "logs") { closeLogs(); render(); }
    if (state.view === "tests") { closeTests(); render(); }
    if (state.view === "backups") { closeBackups(); render(); }
    return true;
  }
  if (action === "tab-backups") {
    if (state.view === "logs") closeLogs();
    const sel = state.rows[state.selected];
    if (state.view !== "backups" && sel) openBackups(sel.name);
    return true;
  }
  if (action === "tab-logs") {
    if (state.view !== "logs") {
      if (state.view === "tests") closeTests();
      if (state.view === "backups") closeBackups();
      const sel = state.rows[state.selected];
      if (sel) openLogs(sel.name);
    }
    return true;
  }
  if (action === "tab-tests") {
    if (state.view === "logs") closeLogs();
    if (state.view === "backups") closeBackups();
    if (state.view !== "tests") openTests();
    return true;
  }
  return false;
}

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

function handleMouse(seq) {
  // SGR: ESC [ < b ; x ; y (M=press, m=release)
  const m = seq.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/);
  if (!m) return;
  const [, bStr, xStr, yStr, kind] = m;
  const b = Number(bStr), x = Number(xStr), y = Number(yStr);
  const isClick = kind === "M" && b === 0;

  // Confirm dialog: only the [Y]es / [N]o buttons are live.
  if (state.mode === "confirm") {
    if (!isClick) return;
    const btn = state.buttonRegions.find((r) => r.y === y && x >= r.x1 && x <= r.x2);
    if (!btn) return;
    const c = state.confirm;
    if (btn.action !== "confirm-yes" && btn.action !== "confirm-no") return;
    state.mode = "list"; state.confirm = null;
    if (btn.action === "confirm-yes") return c?.onYes?.();
    return c?.onNo ? c.onNo() : render();
  }
  if (state.mode !== "list") return; // text modals: keyboard only

  // Backups tab: wheel moves the cursor, clicks press buttons.
  if (state.view === "backups") {
    if (b === 64) return moveBackup(-1);
    if (b === 65) return moveBackup(1);
    if (!isClick || state.busy) return;
    const btn = state.buttonRegions.find((r) => r.y === y && x >= r.x1 && x <= r.x2);
    if (!btn) return;
    if (handleTabClick(btn.action)) return;
    return BACKUP_BUTTONS[btn.action]?.();
  }

  // Tests tab: wheel moves the cursor, clicks pick files / press buttons.
  if (state.view === "tests") {
    const T = state.tests;
    if (b === 64) return moveCursor(-1);
    if (b === 65) return moveCursor(1);
    if (!isClick) return;
    const btn = state.buttonRegions.find((r) => r.y === y && x >= r.x1 && x <= r.x2);
    if (btn) {
      if (handleTabClick(btn.action)) return;
      return TEST_BUTTONS[btn.action]?.();
    }
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

  // Logs tab: wheel scrolls, clicks only on the header tabs.
  if (state.view === "logs") {
    const L = state.logs;
    if (b === 64 && L) { L.follow = false; L.scroll = Math.max(0, L.scroll - 3); return render(); }
    if (b === 65 && L) { L.scroll += 3; return render(); } // render clamps; at bottom it just stays
    if (!isClick) return;
    const btn = state.buttonRegions.find((r) => r.y === y && x >= r.x1 && x <= r.x2);
    if (btn) handleTabClick(btn.action);
    return;
  }

  if (b === 64) { // wheel up
    state.selected = Math.max(0, state.selected - 1);
    return render();
  }
  if (b === 65) { // wheel down
    state.selected = Math.min(state.rows.length - 1, state.selected + 1);
    return render();
  }
  if (!isClick) return; // left-button press only

  // Row click: first click selects; a click on the URL cell or a
  // double-click anywhere on the row opens the browser.
  const rowIndex = y - state.rowRegionStart + state.scroll;
  if (y >= state.rowRegionStart && rowIndex >= 0 && rowIndex < state.rows.length) {
    const now = Date.now();
    const isDouble = lastClick.row === rowIndex && now - lastClick.t < DOUBLE_CLICK_MS;
    lastClick = { row: rowIndex, t: isDouble ? 0 : now };
    state.selected = rowIndex;
    if (isDouble) return run("open");
    if (state.urlCol && x >= state.urlCol.x1 && x <= state.urlCol.x2) return run("open");
    return render();
  }
  // Header tab / footer button click
  const btn = state.buttonRegions.find((r) => r.y === y && x >= r.x1 && x <= r.x2);
  if (!btn) return;
  if (handleTabClick(btn.action)) return;
  run(btn.action);
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

  // Backups tab
  if (state.view === "backups") {
    if (seq === "\x1b" || ch === "\t") { closeBackups(); return render(); }
    if (state.busy) return;
    if (seq === "\x1b[A") return moveBackup(-1);
    if (seq === "\x1b[B") return moveBackup(1);
    if (seq === "\x1b[15~") return reloadBackups();
    switch (ch?.toLowerCase()) {
      case "q": return quit();
      case "\x03": return quit();
      case "j": return moveBackup(1);
      case "k": return moveBackup(-1);
      case "n": return backupNow();
      case "r": return restoreSelected();
      case "d": return deleteSelected();
    }
    return;
  }

  // Tests tab
  if (state.view === "tests") {
    if (seq === "\x1b" || ch === "\t") { closeTests(); return render(); }
    if (seq === "\x1b[A") return moveCursor(-1);
    if (seq === "\x1b[B") return moveCursor(1);
    if (seq === "\x1b[5~") return scrollDetail(-(state.tests?.listH || 10));
    if (seq === "\x1b[6~") return scrollDetail(state.tests?.listH || 10);
    if (seq === "\x1b[15~") return openTests(); // F5: re-scan test files
    if (ch === " ") return togglePick();
    if (ch === "\r") return runSelection();
    switch (ch?.toLowerCase()) {
      case "q": return quit();
      case "\x03": return quit();
      case "j": return moveCursor(1);
      case "k": return moveCursor(-1);
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
    if (seq === "\x1b" || ch === "\t" || ch?.toLowerCase() === "l") {
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
      case "a": { // toggle scope: one tenant ↔ every pm2 process
        const sel = state.rows[state.selected];
        return void openLogs(L?.name ? null : (sel?.name || null));
      }
      case "f": if (L) { L.follow = true; render(); } return;
    }
    return;
  }

  switch (seq) {
    case "\x1b[A": state.selected = Math.max(0, state.selected - 1); return render();
    case "\x1b[B": state.selected = Math.min(state.rows.length - 1, state.selected + 1); return render();
    case "\x1b[D": state.colOff = Math.max(0, (state.colOff || 0) - 1); return render(); // ← show columns to the left
    case "\x1b[C": state.colOff = (state.colOff || 0) + 1; return render(); // → show columns to the right (render clamps)
    case "\x1b[5~": state.selected = Math.max(0, state.selected - (state.tableH || 10)); return render(); // PgUp
    case "\x1b[6~": state.selected = Math.min(state.rows.length - 1, state.selected + (state.tableH || 10)); return render(); // PgDn
    case "\x1b[H": case "\x1b[1~": state.selected = 0; return render(); // Home
    case "\x1b[F": case "\x1b[4~": state.selected = Math.max(0, state.rows.length - 1); return render(); // End
    case "\x1b[15~": return run("refresh"); // F5
  }
  if (ch === "\t") return run("logs");
  if (ch === "L") return run("logs-all"); // shift+L → merged stream of ALL processes
  if (ch === "T") return openTests(); // shift+T → tests tab (t = stop)
  if (ch === "B") { const sel = state.rows[state.selected]; return sel ? openBackups(sel.name) : undefined; } // shift+B → backups of the selected tenant
  switch (ch?.toLowerCase()) {
    case "q": return quit();
    case "\x03": return quit(); // Ctrl+C
    case "j": state.selected = Math.min(state.rows.length - 1, state.selected + 1); return render();
    case "k": state.selected = Math.max(0, state.selected - 1); return render();
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
