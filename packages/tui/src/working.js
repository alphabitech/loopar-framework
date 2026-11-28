/**
 * Blocking work: an operation that leaves the console's picture untrue while
 * it runs (the server restarting, a tenant being restored, created, reset or
 * destroyed). A modal without a close button shows its steps; nothing else
 * can be pressed until it ends.
 *
 * The way out: when the steps stop moving for SLOW_MS, Esc hides the modal
 * (the operation keeps running; its buttons stay disabled and the header
 * shows it). Ctrl+C always quits the TUI.
 */
import { state } from "./state.js";
import { render } from "./render.js";

const SLOW_MS = 60_000;
const TICK_MS = 250;
const SPIN = ["◐", "◓", "◑", "◒"];

/**
 * Run `fn(step)` behind the working modal. `step(text)` adds a progress line
 * (repeats are ignored). Returns fn's result, rethrows its error; the caller
 * reports the outcome and renders.
 */
export async function working(title, fn) {
  const w = { title, steps: [], startedAt: Date.now(), changedAt: Date.now(), hidden: false, frame: 0 };
  state.working = w;
  state.busy = true;
  state.pressed = null;
  render();
  const timer = setInterval(() => { w.frame++; render(); }, TICK_MS);
  const step = (text) => {
    const t = String(text ?? "").trim();
    if (!t || w.steps.at(-1) === t) return;
    w.steps.push(t);
    w.changedAt = Date.now();
    render();
  };
  try {
    return await fn(step);
  } finally {
    clearInterval(timer);
    if (state.working === w) state.working = null;
    state.busy = false;
  }
}

/** True when the steps have not moved for a while: Esc may hide the modal. */
export const workingSlow = (w = state.working) => !!w && Date.now() - w.changedAt > SLOW_MS;

export const spinFrame = (w = state.working) => SPIN[(w?.frame || 0) % SPIN.length];

/** Seconds since the work started. */
export const workingSecs = (w = state.working) => (w ? Math.round((Date.now() - w.startedAt) / 1000) : 0);

/** The working modal is on screen (it owns the keyboard and the mouse). */
export const workingModal = () => !!state.working && !state.working.hidden;

/** Esc on a slow operation: stop blocking the view, keep the work running. */
export function hideWorking() {
  if (!state.working || !workingSlow()) return false;
  state.working.hidden = true;
  render();
  return true;
}

/**
 * What can still be pressed while something works (hidden modal): moving
 * around and the tests. Server and tenant actions wait.
 */
export const allowedWhileWorking = (action) =>
  action === "quit" || /^(tab|panel|tests)-/.test(action);
