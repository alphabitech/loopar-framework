/**
 * Backups of the selected tenant — the body of the Tenants panel: list (as the
 * desk's lineage tree), back up now, restore in place, delete. Restores go to
 * the running core when the server is up (same job as the desk); with the
 * server down they run here, without the framework (native dumps only).
 *
 * One state per tenant, cached: moving through the sidebar shows the local
 * backups at once (a directory read) and merges the remote destination's a
 * moment later (a network call), only for the tenant still selected.
 *
 * Keys (backups view): ↑↓ move · n back up now · r restore · d delete ·
 * F5 reload · Tab/Esc back to tenants
 */
import {
  listBackups, listLocalBackups, createBackup, restoreBackup, deleteBackup, readSettingsBare, readHead,
} from "loopar/core/backup/index.js";
import { buildLineage, layoutLanes } from "./backup-tree.js";
import { restoreInCore } from "./core-ipc.js";
import { readTenant } from "loopar/bin/tenant/tenant-builder.js";
import { state } from "./state.js";
import { render } from "./render.js";
import { actions, openWizard, loadRows } from "./actions.js";
import { silenced } from "./term.js";

const cache = new Map(); // tenant → its backups state

function emptyState(tenant) {
  return { tenant, rows: [], cursor: 0, scroll: 0, listH: 10, destination: null, remoteError: null, loading: false, loaded: false, remoteAt: 0 };
}

function B() {
  state.backups ??= emptyState(null);
  return state.backups;
}

/** Tree + HEAD for the current rows (the same model the desk draws). */
function relineage(b) {
  b.head = readHead(process.cwd(), b.tenant);
  b.lineage = buildLineage(b.rows, b.head);
  b.tree = layoutLanes(b.rows, b.lineage);
  b.cursor = Math.min(b.cursor, Math.max(0, b.rows.length - 1));
}

// Same row shape the desk feeds its tree: `parent` from the manifest
// (undefined = made before lineage was recorded).
const withParent = (row) => ({ ...row, parent: row.manifest ? row.manifest.parent : undefined });

let remoteTimer = null;
const REMOTE_DELAY_MS = 350; // only after the cursor rests on a tenant

/**
 * Show `tenant`'s backups (called by the Tenants view whenever the selection
 * changes). Local backups are read synchronously; the full list (remote
 * destination included) follows when the selection stays put.
 */
export function showBackupsOf(tenant) {
  if (!tenant || state.backups?.tenant === tenant) return;
  let b = cache.get(tenant);
  if (!b) { b = emptyState(tenant); cache.set(tenant, b); }
  state.backups = b;
  if (!b.loaded) {
    try {
      const local = listLocalBackups(process.cwd(), tenant).map((r) => withParent({ ...r, local: true, remote: false }));
      // Keep remote-only rows from a previous full load out until it is redone.
      b.rows = local;
      relineage(b);
    } catch (e) { b.remoteError = e.message; }
  }
  clearTimeout(remoteTimer);
  remoteTimer = setTimeout(() => {
    if (state.backups?.tenant === tenant) reloadBackups({ keepMessage: true });
  }, REMOTE_DELAY_MS);
}

/** Drop a tenant's cached backups (it was destroyed / reset). */
export function forgetBackups(tenant) {
  cache.delete(tenant);
  if (state.backups?.tenant === tenant) state.backups = null;
}

/**
 * Re-read the list (and the lineage tree). `keepMessage`: leave the status
 * line alone — after a backup/restore/delete it carries the result, which the
 * "N backup(s)" summary used to overwrite (the restore looked like a no-op).
 */
export async function reloadBackups({ keepMessage = false } = {}) {
  const b = B();
  if (!b.tenant) return;
  b.loading = true;
  render();
  try {
    const r = await silenced(() => listBackups({ tenant: b.tenant }));
    b.rows = r.rows.map(withParent);
    b.destination = r.destination;
    b.remoteError = r.remoteError;
    b.loaded = true;
    relineage(b);
    if (r.remoteError) {
      state.message = `${r.destination}: ${r.remoteError}`; state.messageKind = "error";
    } else if (!keepMessage) {
      state.message = `${b.rows.length} backup(s) of ${b.tenant}`; state.messageKind = "info";
    }
  } catch (e) {
    state.message = e.message; state.messageKind = "error";
  }
  b.loading = false;
  render();
}

export function moveBackup(delta) {
  const b = B();
  b.cursor = Math.min(Math.max(0, b.cursor + delta), Math.max(0, b.rows.length - 1));
  render();
}

export async function backupNow() {
  const b = B();
  state.busy = true;
  state.message = `backing up ${b.tenant}…`;
  render();
  try {
    const r = await silenced(() => createBackup({ tenant: b.tenant, kind: "manual", onStep: (s) => { state.message = `backing up ${b.tenant}: ${s}…`; render(); } }));
    state.message = `✓ ${r.file}${r.remote.destination ? (r.remote.ok ? ` · copied to ${r.remote.destination}` : ` · NOT copied: ${r.remote.error}`) : ""}`;
    state.messageKind = r.remote.ok === false ? "error" : "ok";
  } catch (e) {
    state.message = e.message; state.messageKind = "error";
  }
  state.busy = false;
  await reloadBackups({ keepMessage: true });
}

const when = (d) => {
  const x = new Date(d);
  const p = (v) => String(v).padStart(2, "0");
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())} ${p(x.getHours())}:${p(x.getMinutes())}`;
};

export async function restoreSelected() {
  const b = B();
  const row = b.rows[b.cursor];
  if (!row) return;
  const settings = await silenced(() => readSettingsBare(process.cwd(), b.tenant));
  const steps = [{
    key: "confirm",
    label: `Type ${b.tenant} to confirm`,
    value: "",
    validate: (v) => v === b.tenant.toLowerCase() || v === b.tenant || "name does not match",
  }];
  if (row.encrypted && !settings.passphrase) steps.push({ key: "passphrase", label: "Backup passphrase", value: "", mask: true, validate: (v) => !!v || "required" });

  openWizard(`Restore · ${b.tenant}`, steps, async ({ passphrase }) => {
    state.busy = true;
    const step = (s) => { state.message = `restoring ${b.tenant}: ${s}…`; render(); };
    try {
      // Server up → the core runs it: the same job as the desk's Backups page
      // (requests gated, tenant re-initialized, both backup formats). Server
      // down → restore from here, as before (native dumps only).
      let r;
      if (state.coreStatus === "online") {
        step("asking the server");
        r = await silenced(() => restoreInCore({ tenant: b.tenant, file: row.file, passphrase, onStep: step }));
      } else {
        r = await restoreOffline(b.tenant, row, passphrase, settings, step);
      }
      state.message = `✓ restored ${row.file}${r?.safety ? ` · previous state saved as ${r.safety}` : ""}`;
      state.messageKind = "ok";
    } catch (e) {
      const offlineOnly = /Loopar's format/.test(e.message) && state.coreStatus !== "online";
      state.message = offlineOnly
        ? "restore failed: this backup is in Loopar's format — start the server (c) and restore it again"
        : `restore failed: ${e.message}`;
      state.messageKind = "error";
    } finally {
      state.busy = false;
      await loadRows();
      await reloadBackups({ keepMessage: true });
    }
  }, {
    body: `Brings ${b.tenant} back to the backup of ${when(row.date)} (${row.kind}). ` +
      `The current state is saved first as a pre-restore backup, so you can come back to it.`,
    submitLabel: " ↺ Restore ",
    submitColor: "yellow",
    border: "yellow",
  });
}

/**
 * Restore without the core (it is down, or the site won't boot): the tenant is
 * turned off for the swap and back on after. Native dumps only — Loopar's
 * format needs the framework running (restoreInCore).
 */
async function restoreOffline(tenant, row, passphrase, settings, step) {
  const wasOn = readTenant(tenant)?.status === "active";
  try {
    if (wasOn) { step("turning it off"); await actions.stop(tenant); }
    return await silenced(() => restoreBackup({
      tenant, file: row.file, passphrase: passphrase || undefined, settings, onStep: step,
    }));
  } finally {
    if (wasOn) await actions.start(tenant).catch(() => {});
  }
}

export function deleteSelected() {
  const b = B();
  const row = b.rows[b.cursor];
  if (!row) return;
  state.mode = "confirm";
  state.confirm = {
    title: `Backups · ${b.tenant}`,
    question: `Delete ${row.file}${row.local && row.remote ? " (here and remote)" : ""}?`,
    onYes: async () => {
      try {
        await silenced(() => deleteBackup({ tenant: b.tenant, file: row.file, where: row.local && row.remote ? "both" : row.local ? "local" : "remote" }));
        state.message = `deleted ${row.file}`; state.messageKind = "ok";
      } catch (e) {
        state.message = e.message; state.messageKind = "error";
      }
      await reloadBackups({ keepMessage: true });
    },
  };
  render();
}
