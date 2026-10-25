/**
 * Navigation trace — a small in-memory ring buffer of every navigation,
 * server-driven redirect and document swap the SPA performs, with the call
 * site that caused it. Always on (cheap), read on demand:
 *
 *   loopar.navTrace()          // console.table of the last entries
 *   window.__looparNavTrace    // raw array
 *
 * Purpose: unexplained redirects / "another page under the same URL" can't
 * be reproduced at will — when one happens, dump this BEFORE reloading.
 */
const MAX = 80;

export function navTrace(kind, detail = {}) {
  if (typeof window === 'undefined') return;
  try {
    const buf = (window.__looparNavTrace ||= []);
    const stack = (new Error().stack || '')
      .split('\n')
      .slice(2, 7)
      .map((s) => s.trim().replace(/^at\s+/, '').replace(/\(?https?:\/\/[^/]+/, '('))
      .join(' ← ');
    buf.push({
      time: new Date().toISOString().slice(11, 23),
      kind,
      at: window.location.pathname + window.location.search,
      ...detail,
      stack,
    });
    if (buf.length > MAX) buf.splice(0, buf.length - MAX);
  } catch {
    /* tracing must never break navigation */
  }
}

export function readNavTrace() {
  return (typeof window !== 'undefined' && window.__looparNavTrace) || [];
}
