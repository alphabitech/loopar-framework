'use strict';

/**
 * Small building blocks shared by the Debugger panels: the API helper,
 * formatting, and a few presentational pieces (panel, pill, empty state,
 * code block). Plain Tailwind on the theme tokens, like the other desk pages.
 */

import { loopar, useRealtime } from "loopar";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@cn/lib/utils";

/** loopar.call("Debugger", action) as a promise, without the freeze overlay. */
export function debugCall(action, query = {}, { notifyError = true } = {}) {
  return loopar.call("Debugger", action, { query, freeze: false, notifyError });
}

/**
 * Load `action` now and whenever `deps` change (filters, Refresh). Live
 * updates don't poll: they arrive on the realtime socket (useDebugStream).
 * Returns { data, loading, error, reload, setData }.
 */
export function useDebugData(action, query, { enabled = true, deps = [] } = {}) {
  const [state, setState] = useState({ data: null, loading: !!enabled, error: null });
  const queryRef = useRef(query);
  queryRef.current = query;
  const seq = useRef(0);

  const reload = useCallback(async ({ quiet = false } = {}) => {
    if (!enabled) return;
    const my = ++seq.current;
    if (!quiet) setState((s) => ({ ...s, loading: true }));
    try {
      const data = await debugCall(action, queryRef.current, { notifyError: !quiet });
      if (my === seq.current) setState({ data, loading: false, error: null });
    } catch (error) {
      if (my === seq.current) setState((s) => ({ ...s, loading: false, error }));
    }
  }, [action, enabled]);

  useEffect(() => { reload(); }, [reload, ...deps]);

  const setData = useCallback((fn) => setState((s) => ({ ...s, data: fn(s.data) })), []);
  return { ...state, reload, setData };
}

/**
 * Subscribe to the Debugger's live channel (`debug:<kind>`): the core pushes
 * new requests, logs, errors and test progress over the realtime socket,
 * only to users allowed to open the Debugger. `kind`: requests | logs |
 * errors | test. Pass `active=false` to pause.
 */
export function useDebugStream(kind, handler, active = true) {
  useRealtime(active && kind ? `debug:${kind}` : null, active ? handler : null);
}

/** Prepend streamed rows to a `{ total, rows }` result, keeping at most `max`. */
export function prependRows(data, rows, max = 300) {
  if (!rows?.length) return data;
  const base = data || { total: 0, rows: [] };
  const fresh = rows.slice().reverse();
  return { ...base, total: (base.total || 0) + rows.length, rows: [...fresh, ...(base.rows || [])].slice(0, max) };
}

// ─── Formatting ──────────────────────────────────────────────────────────────

export const fmtTime = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleTimeString([], { hour12: false });
};

export const fmtDateTime = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString([], { hour12: false });
};

export const fmtMs = (ms) => {
  if (ms === null || ms === undefined) return "—";
  const n = Number(ms);
  if (n >= 1000) return `${(n / 1000).toFixed(2)} s`;
  if (n >= 100) return `${Math.round(n)} ms`;
  return `${n.toFixed(n < 10 ? 2 : 1)} ms`;
};

export const fmtDuration = (sec) => {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
};

export function statusTone(status) {
  const n = Number(status);
  if (!n) return "muted";
  if (n >= 500) return "danger";
  if (n >= 400) return "warning";
  if (n >= 300) return "info";
  return "success";
}

export function durationTone(ms) {
  const n = Number(ms) || 0;
  if (n >= 1000) return "danger";
  if (n >= 300) return "warning";
  return "muted";
}

// ─── Pieces ──────────────────────────────────────────────────────────────────

const TONES = {
  success: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
  warning: "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30",
  danger: "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30",
  info: "bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/30",
  primary: "bg-primary/15 text-primary border-primary/30",
  muted: "bg-muted text-muted-foreground border-border",
};

export function Pill({ tone = "muted", className, children, title }) {
  return (
    <span title={title} className={cn("inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-none whitespace-nowrap", TONES[tone] || TONES.muted, className)}>
      {children}
    </span>
  );
}

export function Panel({ title, actions, className, children, bodyClassName }) {
  return (
    <section className={cn("min-w-0 rounded-xl border border-border bg-card", className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
          {title && <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">{title}</h3>}
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cn("min-w-0 p-4", bodyClassName)}>{children}</div>
    </section>
  );
}

export function Empty({ children = "Nothing recorded yet." }) {
  return <div className="py-8 text-center text-sm text-muted-foreground">{children}</div>;
}

export function Code({ children, className }) {
  return (
    <pre className={cn("max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-muted/40 p-3 font-mono text-xs leading-relaxed text-foreground", className)}>
      {children}
    </pre>
  );
}

export function KeyValues({ data }) {
  const entries = Object.entries(data || {});
  if (!entries.length) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <dl className="grid grid-cols-[minmax(8rem,auto)_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs">
      {entries.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="truncate text-muted-foreground">{k}</dt>
          <dd className="break-all font-mono text-foreground">
            {v === null || v === undefined || v === "" ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export const fieldClass = "h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring";

export function Select({ value, onChange, options, className }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={cn(fieldClass, className)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}

/** Plain-text copy to clipboard with a short confirmation. */
export function CopyButton({ text, label = "Copy", className }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={cn("rounded-md border border-border px-2 py-1 text-xs hover:bg-accent", className)}
      onClick={async () => {
        try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); } catch { /* clipboard blocked */ }
      }}
    >
      {done ? "Copied" : label}
    </button>
  );
}
