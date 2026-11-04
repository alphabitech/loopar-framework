import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router";
import { loopar, useRealtime } from "loopar";
import { Link } from "@link";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@cn/components/ui/dropdown-menu";
import { BugIcon } from "lucide-react";

/**
 * Debugger chip (desk header) — the Yii/Laravel debug toolbar, folded into
 * one header item: timing and SQL count of the user's latest request, new
 * server errors, and the last few requests one click from their detail.
 *
 * Renders nothing unless the Debugger answers (collector on, the user may
 * open it); after one refusal it stays quiet for the rest of the session.
 * Once shown it follows the user's requests and new errors live, over the
 * Debugger's realtime channel — no polling.
 */
const tone = (r, errors) => {
  if (errors > 0 || (r?.status ?? 0) >= 500) return "text-red-600 dark:text-red-400";
  if ((r?.status ?? 0) >= 400 || (r?.durationMs ?? 0) >= 1000 || r?.repeatedQueries) return "text-amber-600 dark:text-amber-400";
  return "text-muted-foreground";
};

const ms = (n) => (n == null ? "—" : n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`);

let refused = false;

export function DebugChip() {
  const location = useLocation();
  const [state, setState] = useState(null);
  const since = useRef(new Date().toISOString());

  useEffect(() => {
    if (refused) return undefined;
    let alive = true;
    // Let the page's own requests land first: they are what the chip reports.
    const timer = setTimeout(() => {
      loopar.call("Debugger", "toolbar", { query: { since: since.current }, freeze: false, notifyError: false })
        .then((data) => {
          if (!alive) return;
          if (!data?.enabled) { refused = true; setState(null); return; }
          setState(data);
        })
        .catch(() => { refused = true; if (alive) setState(null); });
    }, 700);
    return () => { alive = false; clearTimeout(timer); };
  }, [location.pathname, location.search]);

  useRealtime(state ? "debug:requests" : null, state ? ({ rows } = {}) => {
    const mine = (rows || []).filter((r) => r.user === state.user).reverse();
    if (mine.length) setState((s) => s && { ...s, recent: [...mine, ...(s.recent || [])].slice(0, 8) });
  } : null);
  useRealtime(state ? "debug:errors" : null, state ? ({ rows } = {}) => {
    const n = (rows || []).filter((e) => e.level === "error").length;
    if (n) setState((s) => s && { ...s, errors: (s.errors || 0) + n });
  } : null);

  if (!state) return null;
  const last = state.recent?.[0];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title="Debugger — your latest request"
          className={`inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2 font-mono text-[11px] hover:bg-accent ${tone(last, state.errors)}`}
        >
          <BugIcon className="h-3.5 w-3.5" />
          {last ? <span>{ms(last.durationMs)} · {last.queryCount}q</span> : <span>debug</span>}
          {state.errors > 0 && <span className="rounded bg-red-500 px-1 text-white">{state.errors}</span>}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[26rem] bg-card p-1">
        <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Your latest requests</div>
        {(state.recent || []).map((r) => (
          <Link
            key={r.id}
            to={`/desk/Debugger/view?request=${r.id}`}
            variant="ghost"
            className="flex w-full items-center gap-2 rounded px-2 py-1 text-left font-mono text-[11px] hover:bg-accent"
          >
            <span className="w-9 shrink-0 text-muted-foreground">{r.method}</span>
            <span className="flex-1 truncate text-foreground" title={r.url}>{r.url}</span>
            <span className={r.status >= 500 ? "text-red-500" : r.status >= 400 ? "text-amber-500" : "text-emerald-500"}>{r.status}</span>
            <span className="w-12 text-right">{ms(r.durationMs)}</span>
            <span className="w-8 text-right">{r.queryCount}q</span>
          </Link>
        ))}
        {!state.recent?.length && <div className="px-2 py-2 text-xs text-muted-foreground">Nothing recorded yet.</div>}
        <div className="mt-1 border-t border-border pt-1">
          <Link to="/desk/Debugger/view" variant="ghost" className="block rounded px-2 py-1 text-xs hover:bg-accent">
            Open Debugger{state.errors > 0 ? ` · ${state.errors} new error${state.errors > 1 ? "s" : ""}` : ""}
          </Link>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
