/**
 * Window scroll across navigations, the way browsers do it for plain pages:
 *
 *   link / loopar.navigate (PUSH, REPLACE)  → top of the page, or the #anchor
 *   back / forward (POP)                     → where that history entry was left
 *   reload                                   → where the entry was left
 *
 * Positions are kept per history entry (react-router's location key + path),
 * in sessionStorage: per tab, never sent to the server, gone with the tab.
 *
 * Wiring: <RouterBridge/> reports every location change (`navigated`), and
 * the entry's DocumentController calls `settle()` once its content is mounted
 * — the moment there is something to scroll. Between both, the old page may
 * still be on screen: its scroll events must not be recorded for the new
 * entry, so recording pauses until the entry settles (or the user scrolls).
 */

const STORAGE_KEY = "loopar:scroll";
const MAX_ENTRIES = 100;
const RESTORE_WINDOW_MS = 1500;
const HEADER_OFFSET = 15;

const isBrowser = () => typeof window !== "undefined";

class ScrollMemory {
  #positions = null;   // Map id → y
  #current = null;     // id of the history entry on screen
  #restore = false;    // the current entry must restore (POP / reload) instead of going to the top
  #pending = false;    // waiting for the entry's content: don't record scroll events
  #settled = null;     // id of the entry already settled
  #installed = false;
  #frame = 0;
  #saveTimer = 0;
  #cancelRestore = null;

  #idOf(location) {
    const key = location?.key || window.history.state?.key || "default";
    const path = location ? `${location.pathname}${location.search}` : `${window.location.pathname}${window.location.search}`;
    return `${key}|${path}`;
  }

  #load() {
    if (this.#positions) return this.#positions;
    let entries = [];
    try { entries = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) || "[]"); } catch { /* private mode, corrupt */ }
    this.#positions = new Map(Array.isArray(entries) ? entries : []);
    return this.#positions;
  }

  #persist() {
    try {
      const entries = [...this.#load()].slice(-MAX_ENTRIES);
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    } catch { /* quota, private mode: positions just live in memory */ }
  }

  #record() {
    if (this.#pending || !this.#current) return;
    const positions = this.#load();
    positions.delete(this.#current); // re-insert: most recent last
    positions.set(this.#current, Math.round(window.scrollY));
    clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => this.#persist(), 300);
  }

  /** A real reload (or back/forward into the page) asks to restore; a fresh visit starts at the top. */
  #initialRestore() {
    try {
      const type = window.performance?.getEntriesByType?.("navigation")?.[0]?.type;
      return type === "reload" || type === "back_forward";
    } catch {
      return false;
    }
  }

  #install() {
    if (this.#installed || !isBrowser()) return;
    this.#installed = true;
    try { window.history.scrollRestoration = "manual"; } catch { /* old browsers */ }

    // Timers, not animation frames: frames stop in background tabs.
    window.addEventListener("scroll", () => {
      if (this.#frame) return;
      this.#frame = setTimeout(() => { this.#frame = 0; this.#record(); }, 100);
    }, { passive: true });

    // The user took over: whatever is on screen now is a real position.
    const takeOver = () => {
      this.#cancelRestore?.();
      if (this.#pending) { this.#pending = false; this.#record(); }
    };
    for (const type of ["wheel", "touchstart", "keydown", "mousedown"]) {
      window.addEventListener(type, takeOver, { passive: true });
    }

    window.addEventListener("pagehide", () => { this.#record(); this.#persist(); });

    this.#current = this.#idOf();
    this.#restore = this.#initialRestore();
    this.#pending = true;
  }

  /**
   * First load: the server-rendered page is already in the DOM, so a reload
   * can go back to its position right away — before hydration — instead of
   * showing the top first and jumping once React mounts.
   */
  boot() {
    if (!isBrowser() || this.#installed) return;
    this.#install();
    if (!this.#restore) return;
    const saved = this.#load().get(this.#current);
    if (!Number.isFinite(saved) || saved <= 0) return;
    this.#settled = this.#current;
    this.#restoreTo(saved);
  }

  /** <RouterBridge/>: the router moved to `location` (`navigationType`: PUSH | REPLACE | POP). */
  navigated(location, navigationType) {
    if (!isBrowser()) return;
    this.#install();
    const id = this.#idOf(location);
    if (id === this.#current) return; // the first render reports the entry we already track

    this.#cancelRestore?.();
    this.#current = id;
    this.#settled = null;
    this.#restore = navigationType === "POP";
    this.#pending = true;
  }

  /**
   * The current entry's content is mounted: put the window where it belongs.
   * `top: true` forces the top (views that never restore). Only the first
   * call per entry counts — nested documents mount too.
   */
  settle({ top = false } = {}) {
    if (!isBrowser()) return;
    this.#install();
    if (this.#settled === this.#current) return;
    this.#settled = this.#current;

    const saved = this.#load().get(this.#current);
    if (!top && this.#restore && Number.isFinite(saved) && saved > 0) {
      this.#restoreTo(saved);
      return;
    }

    if (!top && window.location.hash && this.#scrollToAnchor(window.location.hash)) {
      this.#pending = false;
      this.#record();
      return;
    }

    window.scrollTo(0, 0);
    this.#pending = false;
    this.#record();
  }

  #scrollToAnchor(hash) {
    let target = null;
    try { target = document.getElementById(decodeURIComponent(hash.slice(1))); } catch { /* malformed hash */ }
    if (!target) return false;
    const header = document.querySelector("header");
    const headerHeight = header ? parseFloat(getComputedStyle(header).height) || 0 : 0;
    window.scrollTo(0, target.getBoundingClientRect().top + window.scrollY - headerHeight - HEADER_OFFSET);
    return true;
  }

  /** Content may still be growing (images, collections loading): retry until it is tall enough. */
  #restoreTo(y) {
    const started = performance.now();
    let frame = 0;
    const done = () => {
      clearTimeout(frame);
      this.#cancelRestore = null;
      this.#pending = false;
      this.#record();
    };
    const attempt = () => {
      window.scrollTo(0, y);
      if (Math.abs(window.scrollY - y) <= 2 || performance.now() - started > RESTORE_WINDOW_MS) return done();
      frame = setTimeout(attempt, 50);
    };
    this.#cancelRestore = done;
    attempt();
  }
}

// One instance per page, even if the module is loaded twice (dev server
// URLs that differ only by a version query are separate module instances).
const GLOBAL_KEY = "__looparScrollMemory__";
export const scrollMemory = typeof globalThis !== "undefined"
  ? (globalThis[GLOBAL_KEY] ||= new ScrollMemory())
  : new ScrollMemory();
if (typeof window !== "undefined" && typeof document !== "undefined") scrollMemory.boot();

export default scrollMemory;
