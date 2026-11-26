'use strict';

import { useCallback, useEffect, useRef, useState } from "react";
import { useDocument } from "@loopar/document";
import { PageLayout } from "@loopar/page";
import { loopar } from "loopar";
import { Link } from "@link";
import { Button } from "@cn/components/ui/button";
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from "@cn/components/ui/context-menu";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@cn/components/ui/dialog";
import { cn } from "@cn/lib/utils";
import {
  DatabaseBackupIcon, DownloadIcon, UploadIcon, RotateCcwIcon, Trash2Icon, RefreshCwIcon, SettingsIcon,
  LockIcon, ServerIcon, CloudIcon, LoaderCircleIcon, TriangleAlertIcon, CheckCircle2Icon, LinkIcon,
  ListIcon, GitForkIcon, MapPinIcon, XIcon,
} from "lucide-react";
import { Pill, Panel, Empty, fmtDateTime, fieldClass } from "../../../../debug/ui/shared.jsx";
import { __ } from "loopar";

const call = (action, query = {}, opts = {}) => loopar.call("Backups", action, { query, freeze: false, ...opts });

const KIND = {
  scheduled: { label: "Scheduled", tone: "info" },
  manual: { label: "Manual", tone: "primary" },
  "pre-update": { label: "Before update", tone: "warning" },
  "pre-restore": { label: "Before restore", tone: "warning" },
  "pre-migrate": { label: "Before migration", tone: "warning" },
  uploaded: { label: "Uploaded", tone: "muted" },
};

const STEP = {
  starting: "Starting…", database: "Copying the database…", archive: "Packing files…", encrypt: "Encrypting…",
  upload: "Sending to the destination…", prune: "Applying retention…", verify: "Checking the backup…",
  safety: "Snapshot of the current state…", swap: "Replacing the site…", done: "Done",
};

/** A step's text: the known ones by name, a detailed one (`database: export 3/40 …`) as it comes. */
const stepText = (step) => STEP[step] || (step ? `${STEP[String(step).split(":")[0]] || ""} ${String(step).includes(":") ? String(step).split(":").slice(1).join(":").trim() : step}`.trim() : "Working…");

/** How a backup's database was saved: native (the engine's dump) or Loopar's own format. */
function FormatPill({ db }) {
  if (!db) return null;
  if (db.format === "loopar") {
    return <Pill tone="info" title={__("Loopar's format: restores into any engine, nothing to install")}>{__("Loopar")}</Pill>;
  }
  const needs = db.requires?.length ? ` — ${__("needs")} ${db.requires.join(", ")}` : "";
  return <Pill tone="muted" title={`${__("Native")} ${db.dialect} ${__("dump: restores into")} ${db.dialect}${needs}`}>{__("Native")} · {db.dialect}</Pill>;
}

/** Why this backup can't be restored here (null: it can). */
function restoreBlocker(db, here) {
  if (!db || !here) return null;
  if (db.format === "loopar") {
    return here.dialect === "sqlite" ? __("A backup in Loopar's format restores into PostgreSQL, MySQL or MariaDB; this site uses SQLite.") : null;
  }
  if (db.dialect !== here.dialect) return `${__("Native")} ${db.dialect} ${__("backup: this site uses")} ${here.dialect}. ${__("Only a backup in Loopar's format restores across engines.")}`;
  const missing = (db.requires || []).filter((t) => /restore/.test(t) && here.tools?.[t] === false);
  return missing.length ? `${__("Restoring it needs")} ${missing.join(", ")}, ${__("not installed on this server.")}` : null;
}

const fmtSize = (n) => {
  const b = Number(n) || 0;
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(2)} GB`;
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(b / 1024))} KB`;
};

const ROOT = "__root__";
const HERE = "__here__";
const LANE = 16;
const ROW = 36;
const laneX = (i) => 10 + i * LANE;

/**
 * Lineage of the backups: each one under the one its state descends from
 * (its `parent`, see engine HEAD). Backups made before lineage was recorded
 * chain by date; every line that starts from nothing hangs from the tenant
 * (the root, like the VM in VMware), except uploaded archives, which come
 * from elsewhere. `lit` is the way from the root to "You are here".
 */
function buildLineage(rows, head) {
  const byFile = new Map(rows.map((r) => [r.file, r]));
  const asc = [...rows].sort((a, b) => new Date(a.date) - new Date(b.date));
  const parentOf = new Map();
  let previous = null;
  for (const r of asc) {
    // `parent` undefined: made before lineage was recorded (chained by date); null: a root.
    let parent = r.parent !== undefined ? r.parent : (r.kind === "uploaded" ? null : previous);
    if (parent && !byFile.has(parent)) parent = null;
    if (!parent && r.kind !== "uploaded") parent = ROOT;
    parentOf.set(r.file, parent);
    if (r.kind !== "uploaded") previous = r.file;
  }
  const current = head && byFile.has(head) ? head : asc.filter((r) => r.kind !== "uploaded").at(-1)?.file ?? null;
  parentOf.set(HERE, current || ROOT);
  const lit = new Set();
  for (let f = HERE; f; f = parentOf.get(f)) lit.add(f);
  return { byFile, parentOf, current, lit };
}

/**
 * Lane layout, VMware's snapshot tree drawn vertically (newest on top). The
 * lanes come from the history alone, so restoring never moves a backup:
 * - a backup's first child (the oldest) goes on in its lane: one line of history;
 * - a later child (made after going back to it) opens a lane to its right;
 * - lanes are reused where they're free, row by row.
 * Only "You are here" moves: on top, in the lane of the backup the site
 * comes from, or in a lane of its own when that backup already has children.
 */
function layoutLanes(rows, lineage) {
  const { parentOf } = lineage;
  const desc = [...rows].sort((a, b) => new Date(b.date) - new Date(a.date));
  const nodes = [{ id: HERE }, ...desc.map((r) => ({ id: r.file, row: r })), { id: ROOT }];
  const rowOf = new Map(nodes.map((n, i) => [n.id, i]));

  // Children of each node, oldest first (rows are newest first, so walk them backwards).
  const children = new Map();
  for (let i = nodes.length - 1; i >= 0; i--) {
    const { id } = nodes[i];
    if (id === HERE) continue;
    const p = parentOf.get(id);
    if (!p) continue;
    if (!children.has(p)) children.set(p, []);
    children.get(p).push(id);
  }
  const firstChild = (id) => children.get(id)?.[0];

  // Chains: a start (the root, an upload, or a later child) and its line of first children.
  const starts = nodes.filter((n) => n.id !== HERE && (n.id === ROOT || !parentOf.get(n.id) || firstChild(parentOf.get(n.id)) !== n.id))
    .reverse(); // oldest first
  const laneOf = new Map();
  const taken = []; // [{ lane, top, bottom }] in rows, inclusive
  const free = (lane, top, bottom) => !taken.some((t) => t.lane === lane && !(t.bottom < top || bottom < t.top));
  for (const start of starts) {
    const chain = [start.id];
    for (let c = firstChild(start.id); c; c = firstChild(c)) chain.push(c);
    const parent = parentOf.get(start.id);
    const top = rowOf.get(chain.at(-1));
    const bottom = parent ? rowOf.get(parent) : rowOf.get(start.id);
    let lane = parent ? laneOf.get(parent) + 1 : 0;
    while (!free(lane, top, bottom)) lane++;
    for (const id of chain) laneOf.set(id, lane);
    taken.push({ lane, top, bottom });
  }

  // "You are here": on the current backup's line when it ends there, else a lane of its own.
  const at = parentOf.get(HERE);
  const atLane = laneOf.get(at) ?? 0;
  let hereLane = !children.has(at) && free(atLane, 0, rowOf.get(at) - 1) ? atLane : atLane + 1;
  while (hereLane !== atLane && !free(hereLane, 0, rowOf.get(at))) hereLane++;
  laneOf.set(HERE, hereLane);

  // What each row draws: the node, and the edges (child → parent) crossing it.
  const segments = nodes.map(() => []);
  for (const n of nodes) {
    const p = parentOf.get(n.id);
    if (!p) continue;
    const from = rowOf.get(n.id);
    const to = rowOf.get(p);
    const edge = { lane: laneOf.get(n.id), into: laneOf.get(p), lit: lineage.lit.has(n.id) };
    segments[from].push({ ...edge, part: "start" });
    for (let r = from + 1; r < to; r++) segments[r].push({ ...edge, part: "through" });
    segments[to].push({ ...edge, part: "end" });
  }
  const width = Math.max(...laneOf.values()) + 1;
  return { nodes: nodes.map((n, i) => ({ ...n, col: laneOf.get(n.id), segments: segments[i] })), width };
}

const edgeClass = (on) => (on ? "stroke-primary/70" : "stroke-muted-foreground/35");

function LaneCell({ node, width, lit, current }) {
  const mid = ROW / 2;
  const xc = laneX(node.col);
  const on = lit.has(node.id);
  return (
    <svg width={laneX(width - 1) + 10} height={ROW} className="flex-shrink-0" aria-hidden="true">
      {node.segments.map((s, i) => {
        const x = laneX(s.lane);
        const d = s.part === "start" ? `M${x} ${mid}V${ROW}`
          : s.part === "through" ? `M${x} 0V${ROW}`
          : s.lane === s.into ? `M${x} 0V${mid}`
          : `M${x} 0C${x} ${mid} ${laneX(s.into)} ${mid * 0.35} ${laneX(s.into)} ${mid}`;
        return <path key={i} d={d} fill="none" strokeWidth="2" className={edgeClass(s.lit)} />;
      })}
      {node.id === HERE ? (
        <circle cx={xc} cy={mid} r="5" strokeWidth="3" className="fill-card stroke-primary" />
      ) : node.id === ROOT ? (
        <rect x={xc - 6} y={mid - 6} width="12" height="12" rx="3" strokeWidth="2" className={cn("fill-card", on ? "stroke-primary" : "stroke-muted-foreground/50")} />
      ) : (
        <circle cx={xc} cy={mid} r="5" strokeWidth="2" strokeDasharray={node.row?.kind === "uploaded" ? "3 2" : undefined}
          className={node.id === current ? "fill-primary stroke-primary" : on ? "fill-card stroke-primary" : "fill-card stroke-muted-foreground/50"} />
      )}
    </svg>
  );
}

/** The backup a "Before restore" snapshot was taken for (the one restored right after it). */
const restoredAfter = (row) => /^before restoring (\S+)$/.exec(row?.note || "")?.[1] ?? null;

function BackupDetail({ row, lineage, page, running, onSelect, onClose, onRestore, onRemove }) {
  if (!row) return null;
  const blocked = restoreBlocker(row.database, page.database);
  const parent = lineage.parentOf.get(row.file);
  const parentRow = parent && parent !== ROOT ? lineage.byFile.get(parent) : null;
  const restored = restoredAfter(row);
  const restoredRow = restored ? lineage.byFile.get(restored) : null;
  const isCurrent = row.file === lineage.current;
  const Item = ({ label, children }) => (
    <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-2 py-1 text-xs">
      <span className="text-muted-foreground">{label}</span><span className="min-w-0">{children}</span>
    </div>
  );
  const Jump = ({ to }) => (
    <button type="button" className="text-left text-primary hover:underline" onClick={() => onSelect(to.file)}>
      {fmtDateTime(to.date)} · {KIND[to.kind]?.label || to.kind}
    </button>
  );
  return (
    <div className="flex flex-col gap-3 p-4">
      <div>
        <div className="flex items-start justify-between gap-2">
          <div className="font-semibold">{fmtDateTime(row.date)}</div>
          <button type="button" className="-mr-1 -mt-1 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground" title={__("Close")} onClick={onClose}>
            <XIcon className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-1 flex flex-wrap gap-1.5">
          <Pill tone={KIND[row.kind]?.tone}>{KIND[row.kind]?.label || row.kind}</Pill>
          <FormatPill db={row.database} />
          {isCurrent && <Pill tone="success"><MapPinIcon className="h-3 w-3" />{__("You are here")}</Pill>}
        </div>
      </div>
      <div className="divide-y divide-border/60">
        <Item label={__("File")}><span className="block truncate font-mono" title={row.file}>{row.file}</span></Item>
        <Item label={__("Size")}>{fmtSize(row.size)}</Item>
        <Item label={__("Stored")}>
          {[row.local && __("this server"), row.remote && page.settings?.destinationLabel].filter(Boolean).join(" · ")}
          {row.encrypted && <LockIcon className="ml-1 inline h-3 w-3 text-emerald-500" />}
        </Item>
        {row.framework && <Item label={__("Loopar")}>{row.framework}</Item>}
        {row.apps && <Item label={__("Apps")}>{Object.entries(row.apps).map(([a, v]) => <span key={a} className="block">{a} <span className="text-muted-foreground">{v}</span></span>)}</Item>}
        <Item label={__("Comes from")}>{parentRow ? <Jump to={parentRow} /> : <span className="text-muted-foreground">{row.kind === "uploaded" ? __("another server (uploaded)") : page.tenant}</span>}</Item>
        {restoredRow && <Item label={__("Then restored")}><Jump to={restoredRow} /></Item>}
        {row.note && !restoredRow && <Item label={__("Note")}>{row.note}</Item>}
      </div>
      {restored && !lineage.lit.has(row.file) && (
        <p className="text-xs text-muted-foreground">{__("The state the site had before that restore. It was set aside, not lost: restoring this backup brings it back.")}</p>
      )}
      {page.isAdministrator && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={!!running || !!blocked || isCurrent} title={blocked || (isCurrent ? __("The site already comes from this backup") : "")} onClick={() => onRestore(row)}>
            <RotateCcwIcon className="mr-1 h-3.5 w-3.5" />{__("Restore")}
          </Button>
          {row.local && (
            <a href={`/api/Backups/download?file=${encodeURIComponent(row.file)}`} className="inline-flex h-8 items-center rounded-md border border-input px-3 text-xs hover:bg-accent">
              <DownloadIcon className="mr-1 h-3.5 w-3.5" />{__("Download")}
            </a>
          )}
          <Button size="sm" variant="outline" className="text-red-600 hover:bg-red-500/10" onClick={() => onRemove(row)}>
            <Trash2Icon className="mr-1 h-3.5 w-3.5" />{__("Delete")}
          </Button>
        </div>
      )}
      {blocked && <p className="text-xs text-amber-600 dark:text-amber-400">{blocked}</p>}
    </div>
  );
}

/**
 * The snapshot tree, VMware's snapshot manager drawn vertically: a lane graph
 * (newest on top) on the left, the selected backup's details and actions on
 * the right; right-click a backup for the same actions.
 */
function BackupTree({ rows, head, page, running, onRestore, onRemove }) {
  const lineage = buildLineage(rows, head);
  const { nodes, width } = layoutLanes(rows, lineage);
  // The details sidebar: closed until a backup is picked; picking it again closes it.
  const [selected, setSelected] = useState(null);
  const selectedRow = lineage.byFile.get(selected) || null;
  const toggle = (file) => setSelected((s) => (s === file ? null : file));
  useEffect(() => {
    if (!selectedRow) return undefined;
    const onKey = (e) => e.key === "Escape" && setSelected(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedRow]);

  const Line = ({ node }) => {
    if (node.id === HERE) {
      return (
        <button type="button" className="flex min-w-0 items-center gap-2 text-sm font-semibold text-primary" onClick={() => lineage.current && toggle(lineage.current)}>
          {__("You are here")}<span className="truncate text-xs font-normal text-muted-foreground">{__("the site's current state")}</span>
        </button>
      );
    }
    if (node.id === ROOT) {
      return (
        <span className="flex min-w-0 items-center gap-2 text-sm">
          <ServerIcon className="h-3.5 w-3.5 text-muted-foreground" /><span className="font-medium">{page.tenant}</span>
          {page.database?.dialect && <Pill tone="muted">{page.database.dialect}</Pill>}
        </span>
      );
    }
    const row = node.row;
    const on = lineage.lit.has(row.file);
    return (
      <span className="flex min-w-0 items-center gap-2 text-sm" title={row.note || row.file}>
        <span className={cn("whitespace-nowrap", on ? "font-medium" : "text-muted-foreground")}>{fmtDateTime(row.date)}</span>
        <Pill tone={KIND[row.kind]?.tone}>{KIND[row.kind]?.label || row.kind}</Pill>
      </span>
    );
  };

  return (
    <div className={cn("grid", selectedRow && "lg:grid-cols-[minmax(0,1fr)_20rem]")}>
      <ul className="min-w-0 overflow-x-auto py-2">
        {nodes.map((node) => {
          const content = (
            <div
              className={cn("flex items-center gap-1 px-3", node.row && "cursor-pointer hover:bg-accent/50", node.id === selected && "bg-accent")}
              style={{ height: ROW }}
              onClick={node.row ? () => toggle(node.id) : undefined}
            >
              <LaneCell node={node} width={width} lit={lineage.lit} current={lineage.current} />
              <Line node={node} />
            </div>
          );
          if (!node.row || !page.isAdministrator) return <li key={node.id}>{content}</li>;
          const blocked = restoreBlocker(node.row.database, page.database);
          return (
            <li key={node.id}>
              <ContextMenu>
                <ContextMenuTrigger asChild>{content}</ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem disabled={!!running || !!blocked || node.id === lineage.current} onSelect={() => onRestore(node.row)}>
                    <RotateCcwIcon className="mr-2 h-4 w-4" />{__("Restore")}
                  </ContextMenuItem>
                  {node.row.local && (
                    <ContextMenuItem onSelect={() => { window.location.href = `/api/Backups/download?file=${encodeURIComponent(node.row.file)}`; }}>
                      <DownloadIcon className="mr-2 h-4 w-4" />{__("Download")}
                    </ContextMenuItem>
                  )}
                  <ContextMenuSeparator />
                  <ContextMenuItem className="text-red-600 focus:text-red-600" onSelect={() => onRemove(node.row)}>
                    <Trash2Icon className="mr-2 h-4 w-4" />{__("Delete")}
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            </li>
          );
        })}
      </ul>
      {selectedRow && (
        // A sidebar: beside the tree on wide screens, a drawer over the page on narrow ones.
        <aside className="fixed inset-y-0 right-0 z-40 w-80 max-w-[90vw] overflow-y-auto border-l border-border bg-card shadow-xl lg:static lg:z-auto lg:w-auto lg:max-w-none lg:overflow-visible lg:shadow-none">
          <div className="lg:sticky lg:top-16">
            <BackupDetail row={selectedRow} lineage={lineage} page={page} running={running}
              onSelect={setSelected} onClose={() => setSelected(null)} onRestore={onRestore} onRemove={onRemove} />
          </div>
        </aside>
      )}
    </div>
  );
}

/** Restore confirmation: what happens, passphrase when needed, type the site name. */
function RestoreDialog({ row, page, onClose, onStarted }) {
  const [confirm, setConfirm] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const needsPassphrase = row?.encrypted && (!page.settings.passphraseSet || row.kind === "uploaded");

  const start = async () => {
    setBusy(true);
    try {
      const r = await call("restore", {}, { body: { file: row.file, confirm, ...(passphrase ? { passphrase } : {}) } });
      onStarted(r.job);
    } catch { /* toast shown */ }
    setBusy(false);
  };

  return (
    <Dialog open={!!row} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><RotateCcwIcon className="h-5 w-5" />{__("Restore this backup?")}</DialogTitle>
          <DialogDescription>
            <span className="font-mono text-xs">{row?.file}</span>
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs leading-relaxed">
            {__("The data, files and settings of")} <strong>{page.tenant}</strong> {__("will be replaced by the ones in this backup (from")} {fmtDateTime(row?.date)}{__("). A snapshot of the current state is taken first, so you can go back. The site is unavailable for a moment and everyone may need to sign in again.")}
          </div>
          {needsPassphrase && (
            <label className="block text-xs">
              <span className="mb-1 block font-medium">{__("Backup passphrase")}</span>
              <input type="password" className={cn(fieldClass, "w-full")} value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
            </label>
          )}
          <label className="block text-xs">
            <span className="mb-1 block font-medium">{__("Type")} <span className="font-mono">{page.tenant}</span> {__("to confirm")}</span>
            <input className={cn(fieldClass, "w-full")} value={confirm} onChange={(e) => setConfirm(e.target.value)} autoFocus />
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{__("Cancel")}</Button>
          <Button variant="destructive" disabled={busy || confirm.trim() !== page.tenant || (needsPassphrase && !passphrase)} onClick={start}>
            {busy ? <LoaderCircleIcon className="mr-1 h-4 w-4 animate-spin" /> : <RotateCcwIcon className="mr-1 h-4 w-4" />}{__("Restore")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Full-screen while a restore runs: the site answers 503 until it re-opens, then the page reloads. */
function RestoreOverlay({ job }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/90 backdrop-blur-sm">
      <div className="max-w-md space-y-3 rounded-xl border border-border bg-card p-6 text-center shadow-xl">
        {job?.finishedAt && job.ok === false
          ? <TriangleAlertIcon className="mx-auto h-10 w-10 text-red-500" />
          : <LoaderCircleIcon className="mx-auto h-10 w-10 animate-spin text-primary" />}
        <div className="text-lg font-semibold">{job?.finishedAt && job.ok === false ? "The restore failed" : "Restoring the backup…"}</div>
        <div className="text-sm text-muted-foreground">
          {job?.finishedAt && job.ok === false
            ? <>{__("Nothing was changed.")} <span className="block pt-2 font-mono text-xs text-red-600 dark:text-red-400">{job.error}</span></>
            : <>{stepText(job?.step)} {__("Don't close this tab: the page reloads by itself when the site is back.")}</>}
        </div>
        {job?.finishedAt && job.ok === false && <Button variant="outline" onClick={() => window.location.reload()}>{__("Close")}</Button>}
      </div>
    </div>
  );
}

function Backups({ data }) {
  const [page, setPage] = useState(data);
  const [loading, setLoading] = useState(false);
  const [job, setJob] = useState(data?.job || null);
  const [restoreRow, setRestoreRow] = useState(null);
  // List or the snapshot tree; remembered by the browser.
  const [view, setView] = useState(() => { try { return localStorage.getItem("loopar-backups-view") || "tree"; } catch { return "tree"; } });
  const pickView = (v) => { setView(v); try { localStorage.setItem("loopar-backups-view", v); } catch { /* private mode */ } };
  const [restoring, setRestoring] = useState(!!data?.restoring);
  const [notice, setNotice] = useState(null);
  const fileInput = useRef(null);
  const s = page?.settings || {};

  const reload = useCallback(async () => {
    setLoading(true);
    try { const r = await call("list", {}, { notifyError: false }); setPage(r.page); setJob(r.page.job); } catch { /* keep */ }
    setLoading(false);
  }, []);

  // First paint lists this server only; the destination comes right after.
  useEffect(() => { reload(); }, [reload]);

  useEffect(() => {
    const p = new URLSearchParams(window.location.search).get("gdrive");
    if (p === "connected") setNotice({ tone: "success", text: "Google Drive connected." });
    if (p === "denied") setNotice({ tone: "warning", text: "Google Drive access was not granted." });
  }, []);

  // A running job is followed until it finishes (a restore: until the site answers again).
  useEffect(() => {
    const active = (job && !job.finishedAt) || restoring;
    if (!active) return undefined;
    const t = setInterval(async () => {
      try {
        const r = await call("status", {}, { notifyError: false });
        setJob(r.job);
        if (restoring && r.job?.type === "restore" && r.job.finishedAt) {
          if (r.job.ok) window.location.reload();
          clearInterval(t);
        } else if (r.job?.finishedAt && !restoring) {
          clearInterval(t);
          reload();
        }
      } catch { /* 503 while the site is being restored: keep waiting */ }
    }, 2000);
    return () => clearInterval(t);
  }, [job?.id, job?.finishedAt, restoring, reload]);

  const backupNow = async () => {
    try { const r = await call("backupNow"); setJob(r.job); } catch { /* toast */ }
  };

  const upload = async (file) => {
    if (!file) return;
    const body = new FormData();
    body.append("archive", file);
    try {
      const r = await call("upload", {}, { body });
      setNotice({ tone: "success", text: `Uploaded as ${r.uploaded}.` });
      reload();
    } catch { /* toast */ }
    if (fileInput.current) fileInput.current.value = "";
  };

  const remove = async (row) => {
    const where = row.local && row.remote ? "both" : row.local ? "local" : "remote";
    if (!window.confirm(`Delete ${row.file}${where === "both" ? " from this server and the destination" : ""}?`)) return;
    try { await call("remove", {}, { body: { file: row.file, where } }); reload(); } catch { /* toast */ }
  };

  const connectDrive = async () => {
    try { const r = await call("gdriveConnect"); window.location.href = r.url; } catch { /* toast */ }
  };

  const running = job && !job.finishedAt;

  return (
    <div className="flex flex-col gap-4 p-1">
      {restoring && <RestoreOverlay job={job} />}
      <RestoreDialog
        row={restoreRow}
        page={page}
        onClose={() => setRestoreRow(null)}
        onStarted={(j) => { setRestoreRow(null); setJob(j); setRestoring(true); }}
      />

      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <DatabaseBackupIcon className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-xl font-bold text-foreground">{__("Backups")}</h1>
            <div className="mt-0.5 flex flex-wrap gap-1.5">
              <Pill tone={s.enabled ? "success" : "muted"}>{s.schedule}</Pill>
              <Pill tone={s.destination === "local" ? "muted" : "info"}>{s.destinationLabel}</Pill>
              <Pill tone={s.encrypt && s.passphraseSet ? "success" : "warning"}><LockIcon className="h-3 w-3" />{s.encrypt && s.passphraseSet ? "encrypted" : "not encrypted"}</Pill>
              <Pill>{__("keeps")} {s.retention?.daily}d · {s.retention?.weekly}w · {s.retention?.monthly}m</Pill>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={!!running} onClick={backupNow}>
            {running && job.type === "backup" ? <LoaderCircleIcon className="mr-1 h-3.5 w-3.5 animate-spin" /> : <DatabaseBackupIcon className="mr-1 h-3.5 w-3.5" />}{__("Back up now")}
          </Button>
          {page.isAdministrator && (
            <>
              <input ref={fileInput} type="file" accept=".gz,.enc" className="hidden" onChange={(e) => upload(e.target.files?.[0])} />
              <Button size="sm" variant="outline" onClick={() => fileInput.current?.click()} title={__("An archive made on another server, or downloaded earlier (up to 50 MB here; larger ones, or MySQL/PostgreSQL archives from elsewhere, with `yarn backup restore`)")}><UploadIcon className="mr-1 h-3.5 w-3.5" />{__("Upload")}</Button>
            </>
          )}
          <Link to="/desk/Backup Settings/update" variant="outline" className="inline-flex h-9 items-center rounded-md border border-input px-3 text-sm hover:bg-accent"><SettingsIcon className="mr-1 h-3.5 w-3.5" />{__("Settings")}</Link>
          <Button size="sm" variant="outline" onClick={reload}><RefreshCwIcon className={cn("mr-1 h-3.5 w-3.5", loading && "animate-spin")} />{__("Refresh")}</Button>
        </div>
      </header>

      {notice && (
        <div className={cn("rounded-lg border p-3 text-sm", notice.tone === "success" ? "border-emerald-500/30 bg-emerald-500/10" : "border-amber-500/30 bg-amber-500/10")}>{notice.text}</div>
      )}
      {s.destination !== "local" && s.encrypt && !s.passphraseSet && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
          {__("Backups can't be sent to")} {s.destinationLabel} {__("until an encryption passphrase is set in")} <Link to="/desk/Backup Settings/update" className="underline">{__("Backup Settings")}</Link>.
        </div>
      )}
      {s.gdrive && !s.gdrive.connected && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-sky-500/30 bg-sky-500/10 p-3 text-sm">
          <span>
            {s.gdrive.configured
              ? <>{__("Google Drive is the destination but it isn't connected yet. Add")} <code className="rounded bg-background px-1 text-xs">{`${typeof window !== "undefined" ? window.location.origin : ""}/desk/Backups/gdriveCallback`}</code> {__("as an authorized redirect URI of the OAuth client.")}</>
              : <>{__("Google Drive needs an OAuth client ID and secret in Backup Settings.")}</>}
          </span>
          {s.gdrive.configured && page.isAdministrator && <Button size="sm" onClick={connectDrive}><LinkIcon className="mr-1 h-3.5 w-3.5" />{__("Connect Google Drive")}</Button>}
        </div>
      )}
      {s.gdrive?.connected && <div className="text-xs text-muted-foreground">{__("Google Drive:")} {s.gdrive.account || "connected"}</div>}
      {page.remoteError && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm">
          <strong>{s.destinationLabel}:</strong> {page.remoteError}
        </div>
      )}

      {job && !restoring && (
        <div className={cn("flex items-center gap-2 rounded-lg border p-3 text-sm",
          !job.finishedAt ? "border-sky-500/30 bg-sky-500/10" : job.ok ? "border-emerald-500/30 bg-emerald-500/10" : "border-red-500/30 bg-red-500/10")}>
          {!job.finishedAt ? <LoaderCircleIcon className="h-4 w-4 animate-spin" /> : job.ok ? <CheckCircle2Icon className="h-4 w-4 text-emerald-500" /> : <TriangleAlertIcon className="h-4 w-4 text-red-500" />}
          <span>
            {!job.finishedAt ? stepText(job.step)
              : job.ok ? (job.type === "backup" ? `Backup created: ${job.result?.file}${job.result?.remote?.ok === false ? ` — not copied to the destination: ${job.result.remote.error}` : ""}` : "Done")
              : `The ${job.type} failed: ${job.error}`}
          </span>
        </div>
      )}

      <Panel
        title={`Backups of ${page.tenant} · ${page.rows?.length ?? 0}`}
        bodyClassName="p-0"
        actions={(
          <div className="flex rounded-md border border-border p-0.5">
            {[["list", ListIcon, __("List")], ["tree", GitForkIcon, __("Tree")]].map(([v, Icon, label]) => (
              <button key={v} type="button" onClick={() => pickView(v)}
                className={cn("flex items-center gap-1 rounded px-2 py-1 text-xs", view === v ? "bg-accent font-medium" : "text-muted-foreground hover:text-foreground")}>
                <Icon className="h-3.5 w-3.5" />{label}
              </button>
            ))}
          </div>
        )}
      >
        {!page.rows?.length ? <Empty>{__("No backups yet. \"Back up now\" makes the first one.")}</Empty> : view === "tree" ? (
          <BackupTree rows={page.rows} head={page.head} page={page} running={running} onRestore={setRestoreRow} onRemove={remove} />
        ) : (
          <div className="overflow-auto">
            <table className="w-full table-fixed text-sm">
              <colgroup>
                <col className="w-48" /><col className="w-32" /><col className="w-24" /><col /><col className="w-44" />
              </colgroup>
              <thead className="text-left text-xs text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="px-4 py-2 font-medium">{__("Date")}</th>
                  <th className="px-2 py-2 font-medium">{__("Type")}</th>
                  <th className="px-2 py-2 text-right font-medium">{__("Size")}</th>
                  <th className="px-3 py-2 font-medium">{__("Stored")}</th>
                  <th className="px-4 py-2 text-right font-medium" />
                </tr>
              </thead>
              <tbody>
                {page.rows.map((r) => (
                  <tr key={r.file} className="border-b border-border/60 hover:bg-accent/40">
                    <td className="px-4 py-2">
                      <div className="font-medium">{fmtDateTime(r.date)}</div>
                      <div className="truncate font-mono text-[11px] text-muted-foreground" title={r.file}>{r.note || r.file}</div>
                    </td>
                    <td className="px-2 py-2"><Pill tone={KIND[r.kind]?.tone}>{KIND[r.kind]?.label || r.kind}</Pill></td>
                    <td className="px-2 py-2 text-right font-mono text-xs">{fmtSize(r.size)}</td>
                    <td className="px-3 py-2">
                      <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                        {r.local && <span className="inline-flex items-center gap-1"><ServerIcon className="h-3.5 w-3.5" />{__("this server")}</span>}
                        {r.remote && <span className="inline-flex items-center gap-1"><CloudIcon className="h-3.5 w-3.5" />{s.destinationLabel}</span>}
                        <FormatPill db={r.database} />
                        {r.encrypted && <LockIcon className="h-3.5 w-3.5 text-emerald-500" title={__("Encrypted")} />}
                        {r.apps && <span className="truncate" title={Object.entries(r.apps).map(([a, v]) => `${a} ${v}`).join("\n")}>· {Object.keys(r.apps).length} {__("apps")}</span>}
                      </span>
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex justify-end gap-1">
                        {page.isAdministrator && (
                          <>
                            <a href={`/api/Backups/download?file=${encodeURIComponent(r.file)}`} className="rounded p-1.5 hover:bg-accent" title={__("Download")}><DownloadIcon className="h-4 w-4" /></a>
                            {(() => {
                              const blocked = restoreBlocker(r.database, page.database);
                              return (
                                <button type="button" className="rounded p-1.5 hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
                                  title={blocked || __("Restore")} disabled={!!running || !!blocked} onClick={() => setRestoreRow(r)}>
                                  <RotateCcwIcon className="h-4 w-4" />
                                </button>
                              );
                            })()}
                            <button type="button" className="rounded p-1.5 text-red-600 hover:bg-red-500/10" title={__("Delete")} onClick={() => remove(r)}><Trash2Icon className="h-4 w-4" /></button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <p className="text-xs text-muted-foreground">
        {__("Kept on this server under")} <code>backups/{page.tenant}/</code>{s.destination !== "local" ? ` and copied to ${s.destinationLabel}` : ""}{__(". A snapshot is taken automatically before installing, updating or uninstalling an app and before every restore. From a terminal:")} <code>yarn backup</code>.
        {page.database && (
          <span className="mt-1 block">
            {page.database.chosen === "native" && Object.values(page.database.tools || {}).some((ok) => !ok)
              ? <span className="text-red-500">{`${__("Backup Settings asks for the native dump, but")} ${Object.entries(page.database.tools).filter(([, ok]) => !ok).map(([t]) => t).join(", ")} ${__("is not installed on this server: backups will fail (snapshots before updates use Loopar's format).")}`}</span>
              : page.database.nextFormat === "native"
              ? `${__("New backups use the native")} ${page.database.dialect} ${__("dump.")}`
              : page.database.dialect === "sqlite"
                ? __("New backups use Loopar's format.")
                : `${__("New backups use Loopar's format:")} ${Object.entries(page.database.tools || {}).filter(([, ok]) => !ok).map(([t]) => t).join(", ")} ${__("is not installed on this server, so the native dump isn't available. Loopar's format restores into any engine.")}`}
          </span>
        )}
      </p>
    </div>
  );
}

export default function BackupsPage() {
  const { Document } = useDocument();
  return (
    <PageLayout>
      <Backups data={Document?.data} />
    </PageLayout>
  );
}
