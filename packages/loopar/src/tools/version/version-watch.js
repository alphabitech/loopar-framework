/**
 * Version watch — keeps an open tab honest about which client bundle it runs.
 *
 * After a zero-downtime deploy the server answers with the NEW code while the
 * tab keeps the OLD bundle until it reloads (version skew). The server stamps
 * every response with `X-Loopar-Build`; this module compares it with the build
 * the page booted with (`__META__.build`) and, once they differ:
 *
 *   - flags the tab as outdated and emits `app:outdated` (the update banner
 *     listens) — nothing is interrupted;
 *   - the next primary navigation becomes a full page load (the user was
 *     leaving the view anyway), see workspace-provider;
 *   - before ANY reload it runs the registered `beforeReload` hooks, which is
 *     how unsaved form work is flushed to the draft store and restored on the
 *     other side (see draft-store / use-form-draft).
 *
 * It also recovers from the classic skew failure: a lazy chunk of the old
 * bundle that is no longer served → one guarded reload instead of a broken
 * view. In development (`__META__.build` null) everything stays dormant.
 *
 * Framework-agnostic and SSR-safe: no window access at import time.
 */
import Emitter from "@services/emitter/emitter";

export const OUTDATED_EVENT = "app:outdated";
export const CURRENT_EVENT = "app:current";

const PROBE_URL = "/__loopar/build";
const PROBE_MIN_INTERVAL = 60_000;       // focus/visibility probes, at most once a minute
const PROBE_BACKGROUND_INTERVAL = 10 * 60_000;
const RELOAD_MARK = "loopar:reload";      // sessionStorage: why we triggered the NEXT load (consumed at boot)
const CHUNK_GUARD_KEY = "loopar:chunk-reload-at";
const CHUNK_RELOAD_GUARD = 20_000;        // never chunk-reload twice within this window
const MARK_MAX_AGE = 2 * 60_000;          // a mark older than this didn't cause this load
const CHUNK_ERROR = /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS/i;

const state = {
  booted: null,
  latest: null,
  outdated: false,
  lastProbe: 0,
  installed: false,
  reloading: false,
  bootMark: null,   // the mark that caused THIS page load, if any
};

const beforeReloadHooks = new Set();

const hasWindow = () => typeof window !== "undefined";

function readMark() {
  try { return JSON.parse(sessionStorage.getItem(RELOAD_MARK) || "null"); } catch { return null; }
}

/** Read and remove the mark: it describes exactly one page load. */
function consumeMark() {
  const mark = readMark();
  try { sessionStorage.removeItem(RELOAD_MARK); } catch { /* storage off */ }
  return mark && Date.now() - mark.at < MARK_MAX_AGE ? mark : null;
}

function writeMark(reason) {
  try { sessionStorage.setItem(RELOAD_MARK, JSON.stringify({ reason, at: Date.now() })); } catch { /* storage off */ }
}

function runBeforeReload(reason) {
  for (const hook of beforeReloadHooks) {
    try { hook(reason); } catch (e) { console.error("[version-watch] beforeReload hook failed", e); }
  }
}

export const versionWatch = {
  /** Build the page booted with (null in development). */
  get booted() { return state.booted; },
  /** Newest build seen from the server. */
  get latest() { return state.latest; },
  get isOutdated() { return state.outdated; },

  /**
   * Why the CURRENT page load happened, if the app itself triggered it:
   * { reason: 'update' | 'chunk' }. Consumed at boot, so it describes this
   * load only — a manual F5 afterwards is not "ours". Lets the draft restore
   * be silent when the reload was the app's own doing.
   */
  lastReload() {
    return state.bootMark;
  },

  /** Called once by entry-client with `__META__.build`. Idempotent. */
  init(bootBuild) {
    state.booted = bootBuild || null;
    state.latest = state.booted;
    if (!hasWindow() || state.installed) return;
    state.installed = true;
    state.bootMark = consumeMark();

    // Chunk of an old bundle missing → one guarded reload (works in dev too:
    // a restarted Vite can invalidate lazy modules the same way).
    window.addEventListener("vite:preloadError", (event) => {
      event.preventDefault?.();
      versionWatch.recoverFromChunkError(event.payload);
    });
    window.addEventListener("unhandledrejection", (event) => {
      const msg = String(event?.reason?.message || event?.reason || "");
      if (CHUNK_ERROR.test(msg)) {
        event.preventDefault?.();
        versionWatch.recoverFromChunkError(event.reason);
      }
    });

    if (!state.booted) return; // development: no build identity to compare

    // A tab can sit idle for hours without a single request: probe when it
    // comes back into view, and slowly in the background while visible.
    const probeIfDue = () => {
      if (document.visibilityState === "visible") versionWatch.probe();
    };
    document.addEventListener("visibilitychange", probeIfDue);
    window.addEventListener("focus", probeIfDue);
    setInterval(probeIfDue, PROBE_BACKGROUND_INTERVAL);
  },

  /** Feed a server build id (the X-Loopar-Build header of any response). */
  observe(serverBuild) {
    if (!state.booted || !serverBuild) return;
    state.latest = serverBuild;

    if (serverBuild !== state.booted && !state.outdated) {
      state.outdated = true;
      Emitter.emit(OUTDATED_EVENT, { booted: state.booted, latest: serverBuild });
    } else if (serverBuild === state.booted && state.outdated) {
      // Rolled back to the build we run: we are current again.
      state.outdated = false;
      Emitter.emit(CURRENT_EVENT, { booted: state.booted });
    }
  },

  /** Ask the server which build is live (throttled; no-op in development). */
  async probe({ force = false } = {}) {
    if (!state.booted || !hasWindow()) return;
    const now = Date.now();
    if (!force && now - state.lastProbe < PROBE_MIN_INTERVAL) return;
    state.lastProbe = now;
    try {
      const res = await fetch(PROBE_URL, { cache: "no-store", credentials: "same-origin" });
      const header = res.headers.get("X-Loopar-Build");
      const body = res.ok ? await res.json().catch(() => null) : null;
      versionWatch.observe(body?.build || header);
    } catch { /* offline / restarting: try again on the next trigger */ }
  },

  /** Subscribe to "a newer build is live". Fires immediately if already outdated. */
  onOutdated(callback) {
    const handler = (info) => callback(info);
    Emitter.on(OUTDATED_EVENT, handler);
    if (state.outdated) callback({ booted: state.booted, latest: state.latest });
    return () => Emitter.off(OUTDATED_EVENT, handler);
  },

  onCurrent(callback) {
    Emitter.on(CURRENT_EVENT, callback);
    return () => Emitter.off(CURRENT_EVENT, callback);
  },

  /**
   * Register work that must happen synchronously before the page unloads for
   * a reload we trigger (flush unsaved form state). Returns the unsubscribe.
   */
  beforeReload(hook) {
    beforeReloadHooks.add(hook);
    return () => beforeReloadHooks.delete(hook);
  },

  /**
   * Reload onto the live build without losing work: flush drafts, mark the
   * reason (so restores can be silent), then load `target` (default: here).
   */
  reload(target, reason = "update") {
    if (!hasWindow() || state.reloading) return;
    state.reloading = true;
    runBeforeReload(reason);
    writeMark(reason);
    if (target && target !== window.location.pathname + window.location.search) {
      window.location.assign(target);
    } else {
      window.location.reload();
    }
  },

  /** A lazy chunk failed to load: reload once; never loop. */
  recoverFromChunkError(error) {
    if (!hasWindow()) return;
    let last = 0;
    try { last = Number(sessionStorage.getItem(CHUNK_GUARD_KEY)) || 0; } catch { /* storage off */ }
    if (Date.now() - last < CHUNK_RELOAD_GUARD) {
      console.error("[version-watch] chunk still failing after reload — not reloading again", error);
      return;
    }
    try { sessionStorage.setItem(CHUNK_GUARD_KEY, String(Date.now())); } catch { /* storage off */ }
    versionWatch.reload(undefined, "chunk");
  },
};

export default versionWatch;
