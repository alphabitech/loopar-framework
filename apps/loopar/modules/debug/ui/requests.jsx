'use strict';

import { useEffect, useMemo, useState } from "react";
import { cn } from "@cn/lib/utils";
import { AlertTriangleIcon, CopyIcon, DatabaseIcon, RepeatIcon, TimerIcon, XIcon } from "lucide-react";
import {
  debugCall, useDebugData, useDebugStream, prependRows, fmtTime, fmtMs, statusTone, durationTone,
  Pill, Panel, Empty, KeyValues, Select, fieldClass,
} from "./shared.jsx";
import { SqlCode, SqlToggle, Console } from "./code.jsx";

const STATUS_OPTIONS = [
  { value: "", label: "Any status" },
  { value: "2xx", label: "2xx" },
  { value: "3xx", label: "3xx" },
  { value: "4xx", label: "4xx" },
  { value: "5xx", label: "5xx" },
];
const METHOD_OPTIONS = [
  { value: "", label: "Any method" },
  { value: "GET", label: "GET" },
  { value: "POST", label: "POST" },
];

function QueryFlags({ row }) {
  return (
    <span className="inline-flex items-center gap-1">
      {row.slowQueries > 0 && <Pill tone="warning" title="Slow queries"><TimerIcon className="h-3 w-3" />{row.slowQueries}</Pill>}
      {row.repeatedQueries > 0 && <Pill tone="danger" title="Same statement repeated (possible N+1)"><RepeatIcon className="h-3 w-3" />N+1</Pill>}
      {row.duplicateQueries > 0 && <Pill tone="warning" title="Identical duplicated queries"><CopyIcon className="h-3 w-3" />{row.duplicateQueries}</Pill>}
    </span>
  );
}

/** Same filters the server applies, for rows that arrive over the socket. */
function matchesFilter(r, f) {
  if (f.q && !String(r.url || "").toLowerCase().includes(f.q.toLowerCase())) return false;
  if (f.method && r.method !== f.method) return false;
  if (f.minMs && (r.durationMs || 0) < Number(f.minMs)) return false;
  if (f.status && Math.floor((r.status || 0) / 100) !== Number(f.status[0])) return false;
  return true;
}

/** Network-tab style list of recorded requests, with filters. New ones stream in. */
export function RequestsPanel({ initial, live, selectedId, onSelect, refreshKey }) {
  const [filter, setFilter] = useState({ q: "", status: "", method: "", minMs: "" });
  const query = useMemo(() => ({ limit: 100, ...Object.fromEntries(Object.entries(filter).filter(([, v]) => v !== "")) }), [filter]);
  const { data, loading, setData } = useDebugData("requests", query, { deps: [JSON.stringify(query), refreshKey] });
  useDebugStream("requests", ({ rows } = {}) => {
    const fresh = (rows || []).filter((r) => matchesFilter(r, filter));
    if (fresh.length) setData((d) => prependRows(d, fresh, 300));
  }, live);
  const result = data || initial || { rows: [], total: 0 };
  const set = (k) => (v) => setFilter((f) => ({ ...f, [k]: v }));

  return (
    <Panel
      title={`Requests · ${result.total ?? 0}`}
      bodyClassName="p-0"
      actions={(
        <>
          <input className={cn(fieldClass, "w-48")} placeholder="URL contains…" value={filter.q} onChange={(e) => set("q")(e.target.value)} />
          <Select value={filter.status} onChange={set("status")} options={STATUS_OPTIONS} />
          <Select value={filter.method} onChange={set("method")} options={METHOD_OPTIONS} />
          <input className={cn(fieldClass, "w-24")} type="number" min="0" placeholder="≥ ms" value={filter.minMs} onChange={(e) => set("minMs")(e.target.value)} />
          {loading && <span className="text-[11px] text-muted-foreground">loading…</span>}
        </>
      )}
    >
      {!result.rows?.length ? <Empty>No requests match. Use the desk in another tab and they show up here.</Empty> : (
        <div className="max-h-[70vh] overflow-auto">
          <table className="w-full table-fixed text-xs">
            <colgroup>
              <col className="w-20" />
              <col className="w-16" />
              <col />
              <col className="w-20" />
              <col className="w-20" />
              <col className="w-32" />
              <col className="w-28" />
            </colgroup>
            <thead className="sticky top-0 z-10 bg-card text-left text-muted-foreground">
              <tr className="border-b border-border">
                <th className="px-3 py-2 font-medium">Time</th>
                <th className="px-2 py-2 font-medium">Method</th>
                <th className="px-2 py-2 font-medium">Request</th>
                <th className="px-2 py-2 font-medium">Status</th>
                <th className="px-2 py-2 text-right font-medium">Duration</th>
                <th className="px-2 py-2 text-right font-medium">SQL</th>
                <th className="px-3 py-2 font-medium">User</th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((r) => (
                <tr
                  key={r.id}
                  onClick={() => onSelect(r.id)}
                  className={cn("cursor-pointer border-b border-border/60 hover:bg-accent/50", selectedId === r.id && "bg-accent")}
                >
                  <td className="px-3 py-1.5 font-mono text-muted-foreground">{fmtTime(r.at)}</td>
                  <td className="px-2 py-1.5"><Pill tone={r.method === "GET" ? "info" : "primary"}>{r.method}</Pill></td>
                  <td className="px-2 py-1.5">
                    <div className="truncate font-mono text-foreground" title={r.url}>{r.url}</div>
                    {(r.document || r.action) && (
                      <div className="truncate text-[11px] text-muted-foreground">{[r.workspace, r.document, r.action].filter(Boolean).join(" › ")}{r.ajax ? " · ajax" : ""}</div>
                    )}
                  </td>
                  <td className="px-2 py-1.5">
                    <span className="inline-flex items-center gap-1">
                      <Pill tone={statusTone(r.status)}>{r.status ?? "…"}</Pill>
                      {r.errorCount > 0 && <AlertTriangleIcon className="h-3.5 w-3.5 text-red-500" />}
                    </span>
                  </td>
                  <td className="px-2 py-1.5 text-right"><Pill tone={durationTone(r.durationMs)}>{fmtMs(r.durationMs)}</Pill></td>
                  <td className="px-2 py-1.5 text-right">
                    <span className="inline-flex items-center gap-1.5">
                      <QueryFlags row={r} />
                      <span className="font-mono">{r.queryCount}</span>
                    </span>
                  </td>
                  <td className="truncate px-3 py-1.5 text-muted-foreground" title={r.user || "guest"}>{r.user || "guest"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function Timeline({ queries, total }) {
  const span = Math.max(total || 0, ...queries.map((q) => (q.offsetMs || 0) + (q.durationMs || 0)), 1);
  return (
    <div className="relative h-2 w-full overflow-hidden rounded bg-muted">
      {queries.map((q, i) => (
        <span
          key={i}
          className={cn("absolute top-0 h-2", q.error ? "bg-red-500" : q.durationMs >= 100 ? "bg-amber-500" : "bg-primary/70")}
          style={{ left: `${((q.offsetMs || 0) / span) * 100}%`, width: `${Math.max(0.4, ((q.durationMs || 0) / span) * 100)}%` }}
        />
      ))}
    </div>
  );
}

function QueryRow({ q, index, flagged }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="border-b border-border/60 py-2 last:border-0">
      <div role="button" tabIndex={0} className="flex w-full cursor-pointer items-start gap-2 text-left" onClick={() => setOpen((o) => !o)}>
        <span className="w-8 shrink-0 pt-2 text-right font-mono text-[11px] text-muted-foreground">{index + 1}</span>
        <div className="min-w-0 flex-1"><SqlCode sql={q.sql} full={open} className={q.error ? "border-red-500/50" : undefined} /></div>
        <span className="flex shrink-0 items-center gap-1 pt-1.5">
          {flagged && <Pill tone="danger">repeated</Pill>}
          {q.tx && <Pill>tx</Pill>}
          {q.late && <Pill title="Ran after the response was sent (after-hooks)">late</Pill>}
          {q.rows !== null && q.rows !== undefined && <Pill>{q.rows} rows</Pill>}
          <Pill tone={q.error ? "danger" : q.durationMs >= 100 ? "warning" : "muted"}>{fmtMs(q.durationMs)}</Pill>
        </span>
      </div>
      {q.error && <Console className="ml-10 mt-1" lines={[{ text: q.error, className: "text-red-400" }]} />}
      {open && (
        <div className="ml-10 mt-2">
          <KeyValues data={{ bindings: q.bindings, offset: fmtMs(q.offsetMs), method: q.method }} />
        </div>
      )}
    </li>
  );
}

const DETAIL_TABS = ["Overview", "Queries", "Logs", "Errors"];

/** Everything recorded for one request (Yii-debug style sub-panels). */
export function RequestDetail({ id, onClose }) {
  const [tab, setTab] = useState("Overview");
  const { data, loading, error } = useDebugData("request", { id }, { deps: [id], live: false });
  const r = data?.request;
  useEffect(() => setTab("Overview"), [id]);

  if (loading && !r) return <Panel title="Request"><Empty>Loading…</Empty></Panel>;
  if (error || !r) return <Panel title="Request" actions={<button onClick={onClose}><XIcon className="h-4 w-4" /></button>}><Empty>{error?.message || "Request not found (the buffer keeps the latest ones only)."}</Empty></Panel>;

  const repeated = new Set((r.analysis?.repeated || []).map((x) => x.sql));
  const counts = { Queries: r.queryCount, Logs: r.logCount, Errors: r.errorCount };

  return (
    <Panel
      title={`${r.method} · ${r.status}`}
      actions={(
        <>
          <span className="font-mono text-[11px] text-muted-foreground">{r.id}</span>
          <button type="button" onClick={onClose} className="rounded p-1 hover:bg-accent"><XIcon className="h-4 w-4" /></button>
        </>
      )}
    >
      <div className="mb-3 break-all font-mono text-xs text-foreground">{r.url}</div>
      <div className="mb-3 flex flex-wrap gap-2">
        <Pill tone={statusTone(r.status)}>{r.status}</Pill>
        <Pill tone={durationTone(r.durationMs)}><TimerIcon className="h-3 w-3" />{fmtMs(r.durationMs)}</Pill>
        <Pill><DatabaseIcon className="h-3 w-3" />{r.queryCount} queries · {fmtMs(r.queryMs)}</Pill>
        <QueryFlags row={r} />
        {r.user && <Pill tone="primary">{r.user}</Pill>}
      </div>

      <div className="mb-3 flex gap-1 border-b border-border">
        {DETAIL_TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn("-mb-px border-b-2 px-3 py-1.5 text-xs", tab === t ? "border-primary font-semibold text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}
          >
            {t}{counts[t] ? ` (${counts[t]})` : ""}
          </button>
        ))}
      </div>

      {tab === "Overview" && (
        <div className="space-y-4">
          <KeyValues data={{ at: r.at, ...r.route, ajax: r.ajax, ip: r.ip, tenant: r.tenant, response: r.response?.type, size: r.response?.size }} />
          <div><h4 className="mb-1 text-xs font-semibold text-muted-foreground">Query params</h4><KeyValues data={r.params?.query} /></div>
          <div><h4 className="mb-1 text-xs font-semibold text-muted-foreground">Body (redacted)</h4><KeyValues data={r.params?.body} /></div>
          <div><h4 className="mb-1 text-xs font-semibold text-muted-foreground">Headers</h4><KeyValues data={r.headers} /></div>
        </div>
      )}

      {tab === "Queries" && (
        <div className="space-y-3">
          <Timeline queries={r.queries} total={r.durationMs} />
          {r.analysis?.repeated?.length > 0 && (
            <div className="rounded-md border border-red-500/30 bg-red-500/10 p-2 text-xs">
              <strong>Possible N+1:</strong>
              <ul className="mt-1 space-y-1">
                {r.analysis.repeated.map((x, i) => <li key={i} className="flex items-start gap-2"><span className="pt-2 font-mono">{x.count}×</span><SqlToggle sql={x.sql} className="flex-1" /></li>)}
              </ul>
            </div>
          )}
          {r.analysis?.duplicates?.length > 0 && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs">
              <strong>Identical duplicates:</strong>
              <ul className="mt-1 space-y-1">
                {r.analysis.duplicates.map((x, i) => <li key={i} className="flex items-start gap-2"><span className="pt-2 font-mono">{x.count}×</span><div className="min-w-0 flex-1"><SqlToggle sql={x.sql} /><div className="mt-0.5 font-mono text-[11px] text-muted-foreground">{JSON.stringify(x.bindings)}</div></div></li>)}
              </ul>
            </div>
          )}
          {!r.queries.length ? <Empty>No SQL.</Empty> : (
            <ol>{r.queries.map((q, i) => <QueryRow key={i} q={q} index={i} flagged={repeated.has(q.sql)} />)}</ol>
          )}
          {r.droppedQueries > 0 && <div className="text-xs text-muted-foreground">+{r.droppedQueries} more not kept.</div>}
        </div>
      )}

      {tab === "Logs" && (!r.logs.length ? <Empty>Nothing logged.</Empty> : <LogLines rows={r.logs} />)}

      {tab === "Errors" && (!r.errors.length ? <Empty>No errors.</Empty> : <ErrorList rows={r.errors} />)}
    </Panel>
  );
}

const LEVEL_COLOR = { error: "text-red-400", warn: "text-amber-300", info: "text-sky-300", debug: "text-zinc-500", log: "text-zinc-400" };

/** Console-style log tail: time, level, text (multi-line kept), link to the request. */
export function LogLines({ rows, onOpenRequest }) {
  return (
    <div className="min-w-0 max-w-full overflow-hidden rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-xs leading-relaxed text-zinc-200">
      {rows.map((l, i) => (
        <div key={i} className="flex gap-3 border-b border-zinc-900 py-0.5 last:border-0">
          <span className="shrink-0 select-none text-zinc-500">{fmtTime(l.at)}</span>
          <span className={cn("w-10 shrink-0 select-none uppercase", LEVEL_COLOR[l.level])}>{l.level}</span>
          <span className={cn("min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]", l.level === "error" && "text-red-300")}>{l.text}</span>
          {onOpenRequest && l.requestId && (
            <button type="button" className="shrink-0 text-sky-400 hover:underline" onClick={() => onOpenRequest(l.requestId)}>request</button>
          )}
        </div>
      ))}
    </div>
  );
}

export function ErrorList({ rows, onOpenRequest }) {
  return (
    <ul className="space-y-2">
      {rows.map((e) => <ErrorItem key={e.id} e={e} onOpenRequest={onOpenRequest} />)}
    </ul>
  );
}

function ErrorItem({ e, onOpenRequest }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="rounded-md border border-border p-2">
      <button type="button" className="flex w-full flex-wrap items-center gap-2 text-left" onClick={() => setOpen((o) => !o)}>
        <Pill tone={e.level === "error" ? "danger" : "warning"}>{e.status}</Pill>
        <span className="font-mono text-[11px] text-muted-foreground">{fmtTime(e.at)}</span>
        <span className="flex-1 truncate text-xs font-medium text-foreground">{e.name ? `${e.name}: ` : ""}{e.text}</span>
        {e.url && <span className="max-w-[16rem] truncate font-mono text-[11px] text-muted-foreground">{e.method} {e.url}</span>}
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          <Console lines={String(e.stack || e.text).split("\n")} />
          <div className="flex gap-3 text-xs">
            <span className="text-muted-foreground">source: {e.source}</span>
            {onOpenRequest && e.requestId && <button type="button" className="text-primary hover:underline" onClick={() => onOpenRequest(e.requestId)}>open request</button>}
          </div>
        </div>
      )}
    </li>
  );
}

export async function clearBuffer() {
  return await debugCall("clear");
}
