/**
 * Navigation trace — a small per-tab ring buffer (kept in sessionStorage,
 * so it survives hard reloads/redirects) of every navigation,
 * server-driven redirect and document swap the SPA performs, with the call
 * site that caused it. Always on (cheap), read on demand:
 *
 *   loopar.navTrace()          // console.table of the last entries
 *   window.__looparNavTrace    // raw array
 *
 * Purpose: unexplained redirects / "another page under the same URL" can't
 * be reproduced at will — when one happens, run loopar.navTrace() in that
 * same tab. The `page` column changes on every full page load.
 */
const MAX = 80;
const KEY = 'loopar:navTrace';

function load() {
  if (window.__looparNavTrace) return window.__looparNavTrace;
  let restored = [];
  try { restored = JSON.parse(sessionStorage.getItem(KEY) || '[]'); } catch { restored = []; }
  window.__looparNavTrace = Array.isArray(restored) ? restored : [];
  return window.__looparNavTrace;
}

export function navTrace(kind, detail = {}) {
  if (typeof window === 'undefined') return;
  try {
    const buf = load();
    const stack = (new Error().stack || '')
      .split('\n')
      .slice(2, 7)
      .map((s) => s.trim().replace(/^at\s+/, '').replace(/\(?https?:\/\/[^/]+/, '('))
      .join(' ← ');
    buf.push({
      time: new Date().toISOString().slice(11, 23),
      page: window.__looparPageId ||= Math.random().toString(36).slice(2, 7),
      kind,
      at: window.location.pathname + window.location.search,
      ...detail,
      stack,
    });
    if (buf.length > MAX) buf.splice(0, buf.length - MAX);
    // Survive hard navigations (window.location.replace / reload) — those
    // are exactly the redirects we want to see afterwards.
    try { sessionStorage.setItem(KEY, JSON.stringify(buf)); } catch { /* quota / privacy mode */ }
  } catch {
    /* tracing must never break navigation */
  }
}

export function readNavTrace() {
  if (typeof window === 'undefined') return [];
  try { return load(); } catch { return []; }
}
