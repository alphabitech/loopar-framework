'use strict';

import { useCallback, useEffect, useState } from "react";
import { useDocument } from "@loopar/document";
import { PageLayout } from "@loopar/page";
import { Button } from "@cn/components/ui/button";
import { cn } from "@cn/lib/utils";
import { BugIcon, PauseIcon, PlayIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { Pill, fmtDuration } from "../../../ui/shared.jsx";
import { RequestsPanel, RequestDetail, clearBuffer } from "../../../ui/requests.jsx";
import { DatabasePanel, LogsPanel, ErrorsPanel, StatusPanel } from "../../../ui/panels.jsx";
import { TestsPanel } from "../../../ui/tests.jsx";
import { ApiPanel } from "../../../ui/tokens.jsx";

const TABS = [
  { key: "requests", label: "Requests" },
  { key: "database", label: "Database" },
  { key: "logs", label: "Logs" },
  { key: "errors", label: "Errors" },
  { key: "status", label: "Status" },
  { key: "tests", label: "Tests" },
  { key: "api", label: "API access" },
];

const LIVE_TABS = new Set(["requests", "database", "logs", "errors"]);

/** ?tab=…&request=… keep the view shareable/reloadable (desk list state lives in the URL too). */
function readUrlState() {
  if (typeof window === "undefined") return {};
  const p = new URLSearchParams(window.location.search);
  return { tab: p.get("tab") || undefined, request: p.get("request") || undefined };
}

function writeUrlState({ tab, request }) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  tab && tab !== "requests" ? url.searchParams.set("tab", tab) : url.searchParams.delete("tab");
  request ? url.searchParams.set("request", request) : url.searchParams.delete("request");
  window.history.replaceState(window.history.state, "", url);
}

function Debugger({ data }) {
  // Defaults on the first render (same as SSR, no hydration mismatch); the
  // URL state is applied right after mount.
  const [tab, setTab] = useState("requests");
  const [selected, setSelected] = useState(null);
  const [urlRead, setUrlRead] = useState(false);
  const [live, setLive] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const enabled = data?.enabled;
  const f = data?.status?.framework || {};

  useEffect(() => {
    const initial = readUrlState();
    if (TABS.some((t) => t.key === initial.tab)) setTab(initial.tab);
    if (initial.request) setSelected(initial.request);
    setUrlRead(true);
  }, []);

  useEffect(() => { if (urlRead) writeUrlState({ tab, request: selected }); }, [tab, selected, urlRead]);

  const openRequest = useCallback((id) => {
    if (!id) return;
    setSelected(id);
    setTab("requests");
  }, []);

  return (
    <div className="flex flex-col gap-4 p-1">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <BugIcon className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-xl font-bold text-foreground">Debugger</h1>
            <div className="mt-0.5 flex flex-wrap gap-1.5">
              <Pill tone={enabled ? "success" : "muted"}>{enabled ? "recording" : "off"}</Pill>
              <Pill tone={f.mode === "production" ? "warning" : "info"}>{f.mode}</Pill>
              {f.build && <Pill>build {f.build}</Pill>}
              <Pill>{f.name} {f.version}</Pill>
              <Pill>node {f.node}</Pill>
              <Pill>up {fmtDuration(f.uptimeSec)}</Pill>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {LIVE_TABS.has(tab) && (
            <Button size="sm" variant={live ? "secondary" : "outline"} onClick={() => setLive((l) => !l)} title="New requests, logs and errors stream in over the realtime socket">
              {live ? <PauseIcon className="mr-1 h-3.5 w-3.5" /> : <PlayIcon className="mr-1 h-3.5 w-3.5" />}{live ? "Live" : "Paused"}
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => setRefreshKey((k) => k + 1)}><RefreshCwIcon className="mr-1 h-3.5 w-3.5" />Refresh</Button>
          <Button size="sm" variant="outline" onClick={async () => { await clearBuffer().catch(() => {}); setSelected(null); setRefreshKey((k) => k + 1); }}>
            <Trash2Icon className="mr-1 h-3.5 w-3.5" />Clear
          </Button>
        </div>
      </header>

      {!enabled && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
          The collector is off (the default in production). To record requests, SQL, logs and errors set
          <code className="mx-1 rounded bg-background px-1">"debug": true</code> in <code className="rounded bg-background px-1">config/core.json</code>
          (or <code className="rounded bg-background px-1">LOOPAR_DEBUG=1</code>) and restart the core. Status, Tests and API access work regardless.
        </div>
      )}

      <nav className="flex flex-wrap gap-1 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={cn("-mb-px border-b-2 px-3 py-2 text-sm", tab === t.key ? "border-primary font-semibold text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === "requests" && (
        <div className={cn("grid gap-4", selected && "2xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]")}>
          <RequestsPanel initial={data?.requests} live={live} selectedId={selected} onSelect={setSelected} refreshKey={refreshKey} />
          {selected && <RequestDetail id={selected} onClose={() => setSelected(null)} />}
        </div>
      )}
      {tab === "database" && <DatabasePanel live={live} refreshKey={refreshKey} onOpenRequest={openRequest} />}
      {tab === "logs" && <LogsPanel live={live} refreshKey={refreshKey} onOpenRequest={openRequest} />}
      {tab === "errors" && <ErrorsPanel live={live} refreshKey={refreshKey} onOpenRequest={openRequest} />}
      {tab === "status" && <StatusPanel initial={data?.status} refreshKey={refreshKey} />}
      {tab === "tests" && <TestsPanel />}
      {tab === "api" && <ApiPanel />}
    </div>
  );
}

export default function DebuggerPage() {
  const { Document } = useDocument();
  return (
    <PageLayout>
      <Debugger data={Document?.data} />
    </PageLayout>
  );
}
