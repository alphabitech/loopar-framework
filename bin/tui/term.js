/**
 * Terminal primitives: ANSI codes, text measurement, screen lifecycle.
 * No local imports — every other TUI module can depend on this one freely.
 */

const ESC = "\x1b";

export const A = {
  reset: `${ESC}[0m`,
  bold: `${ESC}[1m`,
  dim: `${ESC}[2m`,
  under: `${ESC}[4m`,
  inv: `${ESC}[7m`,
  green: `${ESC}[32m`,
  red: `${ESC}[31m`,
  yellow: `${ESC}[33m`,
  cyan: `${ESC}[36m`,
  magenta: `${ESC}[35m`,
  gray: `${ESC}[90m`,
  altOn: `${ESC}[?1049h`,
  altOff: `${ESC}[?1049l`,
  cursorOff: `${ESC}[?25l`,
  cursorOn: `${ESC}[?25h`,
  mouseOn: `${ESC}[?1000;1002;1006h`,
  mouseOff: `${ESC}[?1000;1002;1006l`,
  clear: `${ESC}[2J${ESC}[H`,
};

// 24-bit color when the terminal advertises it (iTerm2, Kitty, WezTerm,
// Ghostty, VS Code, Windows Terminal); otherwise the bright ANSI (9x) slot,
// which is still far more vivid than the base 3x colors used above.
const TRUECOLOR = /^(truecolor|24bit)$/i.test(process.env.COLORTERM || "")
  || /^(iTerm\.app|WezTerm|ghostty|vscode)$/i.test(process.env.TERM_PROGRAM || "")
  || !!process.env.KITTY_WINDOW_ID || !!process.env.WT_SESSION;

const tc = (r, g, b, fallback) => (TRUECOLOR ? `${ESC}[38;2;${r};${g};${b}m` : `${ESC}[${fallback}m`);

/** Log-line palette (see render.js paintLog). */
export const LOG = {
  error:    `${A.bold}${tc(255, 92, 92, 91)}`,   // 5xx headline, "SyntaxError: …"
  ownFrame: `${A.bold}${tc(86, 214, 255, 96)}`,  // stack frames in OUR code
  frame:    tc(112, 120, 135, 90),               // node_modules / internals
  http:     tc(255, 200, 70, 93),                // [4xx]
  noise:    tc(168, 150, 90, 33),                // React/Node warnings, [Cache]
  cont:     tc(112, 120, 135, 90),               // continuation lines
};

/**
 * OSC 8 hyperlink — renders `text` as a real clickable link (Cmd/Ctrl+click)
 * in iTerm2, Kitty, WezTerm, Ghostty, Windows Terminal and VS Code; terminals
 * without OSC 8 support (e.g. macOS Terminal.app) ignore the sequence and
 * show plain text. Zero display width — strip with stripAnsi before padding.
 */
export const link = (text, url) =>
  url ? `${ESC}]8;;${url}${ESC}\\${text}${ESC}]8;;${ESC}\\` : text;

export const stripAnsi = (s) => s
  .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC (hyperlinks, titles)
  .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");           // CSI (colors, cursor)

export const pad = (s, n) => {
  const visible = stripAnsi(s);
  return visible.length >= n
    ? s.slice(0, s.length - (visible.length - n))
    : s + " ".repeat(n - visible.length);
};

/** Alternate screen + hidden cursor + SGR mouse reporting. */
export function enterScreen() {
  process.stdout.write(A.altOn + A.cursorOff + A.mouseOn);
}

export function exitScreen() {
  process.stdout.write(A.mouseOff + A.cursorOn + A.altOff);
}

export function quit(code = 0) {
  exitScreen();
  process.exit(code);
}

/**
 * tenant-ops logs progress with console.log (fine for the CLI, corrupts an
 * alt-screen TUI) — mute the console while those calls run.
 */
export async function silenced(fn) {
  const { log, error } = console;
  console.log = () => {};
  console.error = () => {};
  try { return await fn(); }
  finally { console.log = log; console.error = error; }
}
