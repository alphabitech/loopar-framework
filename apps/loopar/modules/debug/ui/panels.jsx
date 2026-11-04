'use strict';

import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@cn/lib/utils";
import {
  useDebugData, useDebugStream, prependRows, fmtTime, fmtMs, fmtDuration, fmtDateTime, Pill, Panel, Empty, KeyValues, Select, fieldClass,
} from "./shared.jsx";
import { LogLines, ErrorList } from "./requests.jsx";
import { SqlToggle } from "./code.jsx";

/** SQL across the buffered requests (aggregated server-side: re-read when new requests stream in). */
export function DatabasePanel({ live, refreshKey, onOpenRequest }) {
  const { data, reload } = useDebugData("queries", { limit: 50 }, { deps: [refreshKey] });
  const pending = useRef(null);
  useDebugStream("requests", () => {
    pending.current ??= setTimeout(() => { pending.current = null; reload({ quiet: true }); }, 2000);
  }, live);
  useEffect(() => () => clearTimeout(pending.current), []);
  const q = data?.queries || { statements: [], slowest: [], failed: [], background: [] };

  return (
    <div className="space-y-4">
      <Panel title="Statements by total time" bodyClassName="p-0">
        {!q.statements.length ? <Empty /> : (
          <div className="max-h-[50vh] overflow-auto">
            {/* Fixed layout: the statement takes the free width, the numbers keep a narrow column each. */}
            <table className="w-full table-fixed text-xs">
              <colgroup>
                <col />
                <col className="w-16" />
                <col className="w-20" />
                <col className="w-20" />
                <col className="w-20" />
                <col className="w-20" />
              </colgroup>
              <thead className="sticky top-0 z-10 bg-card text-left text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="px-3 py-2 font-medium">Statement</th>
                  <th className="px-2 py-2 text-right font-medium">Count</th>
                  <th className="px-2 py-2 text-right font-medium">Requests</th>
                  <th className="px-2 py-2 text-right font-medium">Total</th>
                  <th className="px-2 py-2 text-right font-medium">Avg</th>
                  <th className="px-3 py-2 text-right font-medium">Max</th>
                </tr>
              </thead>
              <tbody>
                {q.statements.map((s, i) => (
                  <tr key={i} className="border-b border-border/60 align-top">
                    <td className="px-3 py-1.5"><SqlToggle sql={s.sql} className="w-full" />{s.errors > 0 && <Pill tone="danger" className="mt-1">{s.errors} failed</Pill>}</td>
                    <td className="px-2 py-2.5 text-right font-mono">{s.count}</td>
                    <td className="px-2 py-2.5 text-right font-mono">{s.requests}</td>
                    <td className="px-2 py-2.5 text-right font-mono">{fmtMs(s.totalMs)}</td>
                    <td className="px-2 py-2.5 text-right font-mono">{fmtMs(s.avgMs)}</td>
                    <td className="px-3 py-2.5 text-right font-mono">{fmtMs(s.maxMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Panel title="Slowest runs">
          {!q.slowest.length ? <Empty /> : (
            <ul className="divide-y divide-border/60 text-xs">
              {q.slowest.slice(0, 20).map((r, i) => (
                <li key={i} className="flex items-start gap-2 py-1.5">
                  <Pill tone={r.durationMs >= 100 ? "warning" : "muted"} className="mt-1.5">{fmtMs(r.durationMs)}</Pill>
                  <SqlToggle sql={r.sql} className="flex-1" />
                  <button type="button" className="shrink-0 text-primary hover:underline" onClick={() => onOpenRequest(r.requestId)}>request</button>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title="Failed queries">
          {!q.failed.length ? <Empty>No failed queries.</Empty> : (
            <ul className="divide-y divide-border/60 text-xs">
              {q.failed.map((r, i) => (
                <li key={i} className="py-1.5">
                  <SqlToggle sql={r.sql} />
                  <div className="mt-1 font-mono text-red-600 dark:text-red-400">{r.error}</div>
                  <button type="button" className="text-primary hover:underline" onClick={() => onOpenRequest(r.requestId)}>request</button>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Panel title="Background (outside a request: jobs, hooks after boot…)">
        {!q.background.length ? <Empty>No background queries.</Empty> : (
          <ul className="divide-y divide-border/60 text-xs">
            {q.background.map((r, i) => (
              <li key={i} className="flex items-start gap-2 py-1.5">
                <span className="shrink-0 font-mono text-muted-foreground">{fmtTime(r.at)}</span>
                <Pill tone={r.error ? "danger" : "muted"} className="mt-1.5">{fmtMs(r.durationMs)}</Pill>
                <SqlToggle sql={r.sql} className="flex-1" />
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

const LEVELS = ["error", "warn", "info", "log", "debug"];

export function LogsPanel({ live, refreshKey, onOpenRequest }) {
  const [levels, setLevels] = useState(new Set(LEVELS));
  const [q, setQ] = useState("");
  const query = useMemo(() => ({ limit: 500, level: [...levels].join(","), ...(q ? { q } : {}) }), [levels, q]);
  const { data, setData } = useDebugData("logs", query, { deps: [JSON.stringify(query), refreshKey] });
  useDebugStream("logs", ({ rows } = {}) => {
    const fresh = (rows || []).filter((l) => levels.has(l.level) && (!q || String(l.text).toLowerCase().includes(q.toLowerCase())));
    if (fresh.length) setData((d) => prependRows(d, fresh, 500));
  }, live);
  const toggle = (l) => setLevels((s) => { const n = new Set(s); n.has(l) ? n.delete(l) : n.add(l); return n; });

  return (
    <Panel
      title={`Logs · ${data?.total ?? 0}`}
      actions={(
        <>
          {LEVELS.map((l) => (
            <button key={l} type="button" onClick={() => toggle(l)} className={cn("rounded-md border px-2 py-1 text-[11px]", levels.has(l) ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground")}>{l}</button>
          ))}
          <input className={cn(fieldClass, "w-48")} placeholder="Text contains…" value={q} onChange={(e) => setQ(e.target.value)} />
        </>
      )}
    >
      {!data?.rows?.length ? <Empty>No log lines.</Empty> : <div className="max-h-[70vh] overflow-auto"><LogLines rows={data.rows} onOpenRequest={onOpenRequest} /></div>}
    </Panel>
  );
}

export function ErrorsPanel({ live, refreshKey, onOpenRequest }) {
  const [level, setLevel] = useState("error");
  const { data, setData } = useDebugData("errors", level ? { level, limit: 200 } : { limit: 200 }, { deps: [level, refreshKey] });
  useDebugStream("errors", ({ rows } = {}) => {
    const fresh = (rows || []).filter((e) => !level || e.level === level);
    if (fresh.length) setData((d) => prependRows(d, fresh, 200));
  }, live);
  return (
    <Panel
      title={`Errors · ${data?.total ?? 0}`}
      actions={<Select value={level} onChange={setLevel} options={[{ value: "error", label: "5xx (errors)" }, { value: "warning", label: "4xx (warnings)" }, { value: "", label: "All" }]} />}
    >
      {!data?.rows?.length ? <Empty>No errors recorded.</Empty> : <ErrorList rows={data.rows} onOpenRequest={onOpenRequest} />}
    </Panel>
  );
}

export function StatusPanel({ initial, refreshKey }) {
  const { data } = useDebugData("status", {}, { deps: [refreshKey] });
  const s = data?.info || initial;
  if (!s) return <Empty>Loading…</Empty>;
  const f = s.framework || {};
  const t = s.tenant || {};
  const c = s.collector || {};

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <Panel title="Framework">
        <KeyValues data={{
          version: `${f.name} ${f.version} (loopar ${f.looparPackage})`,
          mode: f.mode,
          serving: f.servingDist ? "prebuilt dist" : "Vite (dev)",
          build: f.build,
          node: f.node,
          platform: f.platform,
          pid: f.pid,
          uptime: fmtDuration(f.uptimeSec),
          memory: f.memory ? `rss ${f.memory.rssMb} MB · heap ${f.memory.heapUsedMb}/${f.memory.heapTotalMb} MB` : null,
          load: f.loadavg?.join(" · "),
          cpus: f.cpus,
          port: f.port,
          redis: f.redis ? "on" : "off",
          debugger: f.debug ? "recording" : "off",
        }} />
      </Panel>
      <Panel title="Tenant">
        <KeyValues data={{
          name: t.name,
          domain: t.domain,
          website: t.website,
          installed: t.installed,
          database: t.db ? `${t.db.dialect} · ${t.db.database}` : null,
          "db server": t.dbServerInitialized,
          "db initialized": t.dbInitialized,
        }} />
      </Panel>
      <Panel title="Apps" bodyClassName="p-0">
        {!s.apps?.length ? <Empty>No apps.</Empty> : (
          <table className="w-full text-xs">
            <thead className="text-left text-muted-foreground">
              <tr className="border-b border-border"><th className="px-3 py-2 font-medium">App</th><th className="px-2 py-2 font-medium">Installed</th><th className="px-2 py-2 font-medium">On disk</th><th className="px-2 py-2 font-medium" /></tr>
            </thead>
            <tbody>
              {s.apps.map((a) => (
                <tr key={a.name} className="border-b border-border/60">
                  <td className="px-3 py-1.5 font-medium">{a.name}</td>
                  <td className="px-2 py-1.5 font-mono">{a.installedVersion ?? "—"}</td>
                  <td className="px-2 py-1.5 font-mono">{a.availableVersion ?? (a.onDisk ? "—" : "missing")}</td>
                  <td className="px-2 py-1.5">{a.updatePending && <Pill tone="warning">update pending</Pill>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
      <Panel title="Backups">
        <KeyValues data={{
          "last backup": s.backup?.last ? `${fmtDateTime(s.backup.last.at)} (${s.backup.last.kind})` : "none",
          "last scheduled": s.backup?.lastScheduled ? fmtDateTime(s.backup.lastScheduled) : "none",
          "kept on this server": s.backup?.count ?? 0,
        }} />
      </Panel>
      <Panel title="Collector">
        <KeyValues data={{
          state: c.enabled ? "recording" : "off",
          "buffer since": fmtDateTime(c.since),
          requests: `${c.requests} (keeps ${c.limits?.requests})`,
          "log lines": c.logs,
          errors: c.errors,
          warnings: c.warnings,
          "background queries": c.backgroundQueries,
          "slow query ≥": c.limits ? `${c.limits.slowQueryMs} ms` : null,
        }} />
      </Panel>
    </div>
  );
}
