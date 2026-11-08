'use strict';

import { useCallback, useEffect, useRef, useState } from "react";
import { useDocument } from "@loopar/document";
import { PageLayout } from "@loopar/page";
import { loopar } from "loopar";
import { Link } from "@link";
import { Button } from "@cn/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@cn/components/ui/dialog";
import { cn } from "@cn/lib/utils";
import {
  DatabaseBackupIcon, DownloadIcon, UploadIcon, RotateCcwIcon, Trash2Icon, RefreshCwIcon, SettingsIcon,
  LockIcon, ServerIcon, CloudIcon, LoaderCircleIcon, TriangleAlertIcon, CheckCircle2Icon, LinkIcon,
} from "lucide-react";
import { Pill, Panel, Empty, fmtDateTime, fieldClass } from "../../../../debug/ui/shared.jsx";
import { __ } from "loopar";

const call = (action, query = {}, opts = {}) => loopar.call("Backups", action, { query, freeze: false, ...opts });

const KIND = {
  scheduled: { label: "Scheduled", tone: "info" },
  manual: { label: "Manual", tone: "primary" },
  "pre-update": { label: "Before update", tone: "warning" },
  "pre-restore": { label: "Before restore", tone: "warning" },
  uploaded: { label: "Uploaded", tone: "muted" },
};

const STEP = {
  starting: "Starting…", database: "Copying the database…", archive: "Packing files…", encrypt: "Encrypting…",
  upload: "Sending to the destination…", prune: "Applying retention…", verify: "Checking the backup…",
  safety: "Snapshot of the current state…", swap: "Replacing the site…", done: "Done",
};

const fmtSize = (n) => {
  const b = Number(n) || 0;
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(2)} GB`;
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(b / 1024))} KB`;
};

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
            : <>{STEP[job?.step] || "Working…"} {__("Don't close this tab: the page reloads by itself when the site is back.")}</>}
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
            {!job.finishedAt ? STEP[job.step] || "Working…"
              : job.ok ? (job.type === "backup" ? `Backup created: ${job.result?.file}${job.result?.remote?.ok === false ? ` — not copied to the destination: ${job.result.remote.error}` : ""}` : "Done")
              : `The ${job.type} failed: ${job.error}`}
          </span>
        </div>
      )}

      <Panel title={`Backups of ${page.tenant} · ${page.rows?.length ?? 0}`} bodyClassName="p-0">
        {!page.rows?.length ? <Empty>{__("No backups yet. \"Back up now\" makes the first one.")}</Empty> : (
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
                        {r.encrypted && <LockIcon className="h-3.5 w-3.5 text-emerald-500" title={__("Encrypted")} />}
                        {r.apps && <span className="truncate" title={Object.entries(r.apps).map(([a, v]) => `${a} ${v}`).join("\n")}>· {Object.keys(r.apps).length} {__("apps")}</span>}
                      </span>
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex justify-end gap-1">
                        {page.isAdministrator && (
                          <>
                            <a href={`/api/Backups/download?file=${encodeURIComponent(r.file)}`} className="rounded p-1.5 hover:bg-accent" title={__("Download")}><DownloadIcon className="h-4 w-4" /></a>
                            <button type="button" className="rounded p-1.5 hover:bg-accent" title={__("Restore")} disabled={!!running} onClick={() => setRestoreRow(r)}><RotateCcwIcon className="h-4 w-4" /></button>
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
        {__("Kept on this server under")} <code>backups/{page.tenant}/</code>{s.destination !== "local" ? ` and copied to ${s.destinationLabel}` : ""}{__(". A snapshot is taken automatically before installing or updating an app and before every restore. From a terminal:")} <code>yarn backup</code>.
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
