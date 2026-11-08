'use strict';

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@cn/lib/utils";
import { Button } from "@cn/components/ui/button";
import {
  PlayIcon, SquareIcon, CheckCircle2Icon, XCircleIcon, LoaderCircleIcon, MinusCircleIcon, ChevronRightIcon,
} from "lucide-react";
import { debugCall, useDebugData, useDebugStream, fmtMs, fmtDateTime, Pill, Panel, Empty, fieldClass } from "./shared.jsx";
import { Console } from "./code.jsx";
import { __ } from "loopar";

const RUN_TONE = { running: "info", passed: "success", failed: "danger", cancelled: "muted", timeout: "warning", error: "danger" };

function StatusIcon({ status, className = "h-4 w-4" }) {
  if (status === "running") return <LoaderCircleIcon className={cn(className, "shrink-0 animate-spin text-sky-500")} />;
  if (status === "passed" || status === "pass") return <CheckCircle2Icon className={cn(className, "shrink-0 text-emerald-500")} />;
  if (status === "failed" || status === "fail") return <XCircleIcon className={cn(className, "shrink-0 text-red-500")} />;
  if (status === "cancelled") return <MinusCircleIcon className={cn(className, "shrink-0 text-amber-500")} />;
  return <MinusCircleIcon className={cn(className, "shrink-0 text-muted-foreground/50")} />;
}

const testKey = (t) => `${t.file}|${t.line}|${(t.path || []).join(">")}|${t.name}`;

/** Console lines of a failure: message, actual/expected, then the stack. */
function failureLines(error = {}) {
  const lines = String(error.message || "(no message)").split("\n");
  if (error.actual !== undefined || error.expected !== undefined) {
    lines.push("", ...String(error.actual).split("\n").map((l, i) => ({ text: l, prefix: i ? " " : "actual  ", className: "text-red-400" })));
    lines.push(...String(error.expected).split("\n").map((l, i) => ({ text: l, prefix: i ? " " : "expected", className: "text-emerald-400" })));
  }
  const frames = String(error.stack || "").split("\n").filter((l) => /^\s+at\s/.test(l));
  if (frames.length) lines.push("", ...frames);
  return lines;
}

/** One test inside an open file: a row; a failure opens to its console. */
function TestRow({ t, error }) {
  const failed = t.status === "fail";
  const [open, setOpen] = useState(failed);
  return (
    <li>
      <button
        type="button"
        disabled={!failed}
        onClick={() => setOpen((o) => !o)}
        className={cn("flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs", failed && "hover:bg-red-500/10")}
      >
        <StatusIcon status={t.status} className="h-3.5 w-3.5" />
        <span className={cn("flex-1 truncate", failed && "font-medium text-red-600 dark:text-red-400")}>
          {t.path?.length ? <span className="text-muted-foreground">{t.path.join(" › ")} › </span> : null}
          {t.name}
        </span>
        <span className="font-mono text-[11px] text-muted-foreground">{fmtMs(t.durationMs)}</span>
      </button>
      {failed && open && <Console className="mb-2 ml-7 mt-1" lines={failureLines(error)} />}
    </li>
  );
}

/** A test file as an accordion row: summary when closed, its tests (and their failures) when open. */
function FileItem({ file, run, tests, errors, output, picked, onPick, open, onToggle, running }) {
  const f = run?.files?.find?.((x) => x.file === file);
  const isCurrent = running && run?.current?.file === file;
  const status = isCurrent ? "running" : f ? (running ? (f.fail ? "failed" : "running") : f.status) : null;
  const short = file.replace(/^test\/(unit|integration)\//, "");

  return (
    <li className={cn("rounded-md", open && "bg-muted/30")}>
      <div className="flex items-center gap-2 px-1 py-1">
        <input type="checkbox" checked={picked} onChange={onPick} onClick={(e) => e.stopPropagation()} />
        <button type="button" onClick={onToggle} className="flex flex-1 items-center gap-2 rounded px-1 py-0.5 text-left text-xs hover:bg-accent">
          <ChevronRightIcon className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
          <span className="flex-1 truncate font-mono" title={file}>{short}</span>
          {f && (
            <span className="flex items-center gap-1.5 font-mono text-[11px]">
              <span className="text-emerald-600 dark:text-emerald-400">{f.pass}✓</span>
              {f.fail > 0 && <span className="text-red-600 dark:text-red-400">{f.fail}✗</span>}
              {f.skip > 0 && <span className="text-muted-foreground">{f.skip}○</span>}
              <span className="w-14 text-right text-muted-foreground">{fmtMs(f.durationMs)}</span>
            </span>
          )}
          <StatusIcon status={status} />
        </button>
      </div>
      {open && (
        <div className="pb-2 pl-8 pr-2">
          {!tests.length && !isCurrent ? (
            <div className="px-2 py-1 text-xs text-muted-foreground">{f || running ? "No results yet." : "Not run in this session — run it to see its tests."}</div>
          ) : (
            <ul>
              {tests.map((t, i) => <TestRow key={i} t={t} error={errors.get(testKey(t))} />)}
              {isCurrent && run.current && (
                <li className="flex items-center gap-2 px-2 py-1 text-xs text-sky-600 dark:text-sky-400">
                  <LoaderCircleIcon className="h-3.5 w-3.5 shrink-0 animate-spin" />
                  <span className="flex-1 truncate">{run.current.name}</span>
                </li>
              )}
            </ul>
          )}
          {output.length > 0 && (
            <div className="mt-1">
              <div className="mb-1 px-2 text-[11px] font-semibold text-muted-foreground">{__("output")}</div>
              <Console maxHeight="max-h-48" lines={output.map((o) => ({ text: o.text, className: o.stream === "stderr" ? "text-amber-300" : undefined }))} />
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/** Run the repo's node:test suite in a child process and follow it live (realtime socket). */
export function TestsPanel() {
  const files = useDebugData("testFiles", {});
  const [picked, setPicked] = useState(new Set());
  const [openFiles, setOpenFiles] = useState(new Set());
  const [pattern, setPattern] = useState("");
  const [run, setRun] = useState(null);
  const [tests, setTests] = useState([]);
  const [starting, setStarting] = useState(false);
  const lastPush = useRef(0);
  const runId = useRef(null);
  const allowed = files.data?.allowed;
  const running = run?.status === "running";

  useEffect(() => { runId.current = run?.id ?? null; }, [run?.id]);

  const loadRun = useCallback(async (id) => {
    try {
      const r = await debugCall("testRun", id ? { id } : {}, { notifyError: false });
      setRun(r.run);
      setTests(r.run?.tests || []);
    } catch { /* no run yet */ }
  }, []);

  useEffect(() => { loadRun(); }, [loadRun]);

  // Progress is pushed over the socket: the snapshot + the tests finished since the last push.
  useDebugStream("test", (msg = {}) => {
    if (!msg.run) return;
    lastPush.current = Date.now();
    const isNew = runId.current !== msg.run.id;
    runId.current = msg.run.id;
    setRun(msg.run);
    setTests((t) => (isNew ? msg.tests || [] : [...t, ...(msg.tests || [])]));
    if (msg.final) loadRun(msg.run.id); // the complete result (every test, full output)
  });

  // Safety net when the socket is down: re-read every 5 s while nothing arrives.
  useEffect(() => {
    if (!running) return undefined;
    const t = setInterval(() => { if (Date.now() - lastPush.current > 5000) loadRun(run.id); }, 5000);
    return () => clearInterval(t);
  }, [running, run?.id, loadRun]);

  // A finished run opens the files that failed.
  useEffect(() => {
    if (!run || running) return;
    const failed = (run.files || []).filter((f) => f.fail > 0).map((f) => f.file);
    if (failed.length) setOpenFiles((s) => new Set([...s, ...failed]));
  }, [run?.id, running]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = async (query) => {
    setStarting(true);
    try {
      const r = await debugCall("runTests", { ...query, ...(pattern ? { namePattern: pattern } : {}) });
      lastPush.current = Date.now();
      setRun(r.run);
      setTests(r.run?.tests || []);
    } catch { /* toast already shown */ }
    setStarting(false);
  };

  const groups = useMemo(() => {
    const g = {};
    for (const f of files.data?.files || []) (g[f.suite] ||= []).push(f.file);
    return g;
  }, [files.data]);

  const testsByFile = useMemo(() => {
    const m = new Map();
    for (const t of tests) { if (!m.has(t.file)) m.set(t.file, []); m.get(t.file).push(t); }
    return m;
  }, [tests]);
  const errors = useMemo(() => new Map((run?.failures || []).map((f) => [testKey(f), f.error])), [run?.failures]);
  const outputByFile = useMemo(() => {
    const m = new Map();
    for (const o of run?.output || []) { if (!o.file) continue; if (!m.has(o.file)) m.set(o.file, []); m.get(o.file).push(o); }
    return m;
  }, [run?.output]);
  const runnerOutput = (run?.output || []).filter((o) => !o.file);

  const toggleSet = (setter, key) => setter((s) => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n; });
  const c = run?.counts;
  const disabled = !allowed || running || starting;

  return (
    <div className="space-y-4">
      <Panel>
        {!allowed && files.data && (
          <div className="mb-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs">{__("Test runs are only available while the core runs in development mode. From a terminal:")} <code>yarn test</code> {__("or the TUI (")}<code>yarn tui</code> {__("→ Tests).")}</div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={disabled} onClick={() => start({ suite: "all" })}><PlayIcon className="mr-1 h-3.5 w-3.5" />{__("All")}</Button>
          <Button size="sm" variant="outline" disabled={disabled} onClick={() => start({ suite: "unit" })}>{__("Unit")}</Button>
          <Button size="sm" variant="outline" disabled={disabled} onClick={() => start({ suite: "integration" })}>{__("Integration")}</Button>
          <Button size="sm" variant="outline" disabled={disabled || !picked.size} onClick={() => start({ files: [...picked].join(",") })}>{__("Selected (")}{picked.size})</Button>
          {running && <Button size="sm" variant="destructive" onClick={() => debugCall("cancelTests", { id: run.id }).then(() => loadRun(run.id))}><SquareIcon className="mr-1 h-3.5 w-3.5" />{__("Stop")}</Button>}
          <input className={cn(fieldClass, "min-w-[14rem] flex-1")} placeholder={__("Only tests whose name matches (regex)…")} value={pattern} onChange={(e) => setPattern(e.target.value)} />
        </div>
        {run && (
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
            <StatusIcon status={run.status} />
            <Pill tone={RUN_TONE[run.status]}>{run.status}</Pill>
            <Pill tone="success">{c.pass} {__("passed")}</Pill>
            <Pill tone={c.fail ? "danger" : "muted"}>{c.fail} {__("failed")}</Pill>
            {c.skip > 0 && <Pill>{c.skip} {__("skipped")}</Pill>}
            {c.cancelled > 0 && <Pill tone="warning">{c.cancelled} {__("cancelled")}</Pill>}
            <Pill>{fmtMs(run.durationMs)}</Pill>
            <span className="truncate text-xs text-muted-foreground">
              {run.args?.files?.length ? `${run.args.files.length} file(s)` : `suite: ${run.args?.suite}`}
              {run.args?.namePattern ? ` · /${run.args.namePattern}/` : ""} · {fmtDateTime(run.startedAt)}
              {run.meta?.requestedBy ? ` · ${run.meta.requestedBy}` : ""}
            </span>
          </div>
        )}
      </Panel>

      <Panel
        title={__("Test files")}
        actions={(
          <>
            <button type="button" className="text-[11px] text-muted-foreground hover:text-foreground" onClick={() => setOpenFiles(new Set((files.data?.files || []).map((f) => f.file)))}>{__("expand all")}</button>
            <button type="button" className="text-[11px] text-muted-foreground hover:text-foreground" onClick={() => setOpenFiles(new Set())}>{__("collapse all")}</button>
          </>
        )}
      >
        {!Object.keys(groups).length ? <Empty>{__("No test files under test/.")}</Empty> : Object.entries(groups).map(([suite, list]) => (
          <div key={suite} className="mb-3 last:mb-0">
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">{suite}</div>
            <ul className="space-y-0.5">
              {list.map((file) => (
                <FileItem
                  key={file}
                  file={file}
                  run={run}
                  tests={testsByFile.get(file) || []}
                  errors={errors}
                  output={outputByFile.get(file) || []}
                  picked={picked.has(file)}
                  onPick={() => toggleSet(setPicked, file)}
                  open={openFiles.has(file)}
                  onToggle={() => toggleSet(setOpenFiles, file)}
                  running={running}
                />
              ))}
            </ul>
          </div>
        ))}
      </Panel>

      {runnerOutput.length > 0 && (
        <Panel title={__("Runner output")}>
          <Console lines={runnerOutput.map((o) => o.text)} />
        </Panel>
      )}
    </div>
  );
}
