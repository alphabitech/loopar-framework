/**
 * Backups tab — the selected tenant's backups, from the terminal, without the
 * framework (works when the site won't boot): list, back up now, restore in
 * place (the tenant is turned off for the swap and back on after), delete.
 *
 * Keys (backups view): ↑↓ move · n back up now · r restore · d delete ·
 * F5 reload · Tab/Esc back to tenants
 */
import {
  listBackups, createBackup, restoreBackup, deleteBackup, readSettingsBare,
} from "loopar/core/backup/index.js";
import { readTenant } from "loopar/bin/tenant/tenant-builder.js";
import { state } from "./state.js";
import { render } from "./render.js";
import { actions, openWizard, loadRows } from "./actions.js";
import { silenced } from "./term.js";

function B() {
  state.backups ??= { tenant: null, rows: [], cursor: 0, scroll: 0, listH: 10, destination: null, remoteError: null, loading: false };
  return state.backups;
}

export async function openBackups(tenant) {
  const b = B();
  if (!tenant) return;
  if (b.tenant !== tenant) Object.assign(b, { tenant, rows: [], cursor: 0, scroll: 0 });
  state.view = "backups";
  await reloadBackups();
}

export function closeBackups() {
  state.view = "tenants";
}

export async function reloadBackups() {
  const b = B();
  b.loading = true;
  render();
  try {
    const r = await silenced(() => listBackups({ tenant: b.tenant }));
    b.rows = r.rows;
    b.destination = r.destination;
    b.remoteError = r.remoteError;
    b.cursor = Math.min(b.cursor, Math.max(0, b.rows.length - 1));
    state.message = r.remoteError ? `${r.destination}: ${r.remoteError}` : `${b.rows.length} backup(s) of ${b.tenant}`;
    state.messageKind = r.remoteError ? "error" : "info";
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
  await reloadBackups();
}

export async function restoreSelected() {
  const b = B();
  const row = b.rows[b.cursor];
  if (!row) return;
  const settings = await silenced(() => readSettingsBare(process.cwd(), b.tenant));
  const steps = [{
    key: "confirm",
    label: `restore ${row.file} over ${b.tenant}? type the tenant name`,
    value: "",
    validate: (v) => v === b.tenant.toLowerCase() || v === b.tenant || "name does not match",
  }];
  if (row.encrypted && !settings.passphrase) steps.push({ key: "passphrase", label: "backup passphrase", value: "", mask: true, validate: (v) => !!v || "required" });

  openWizard("Restore", steps, async ({ passphrase }) => {
    state.busy = true;
    const wasOn = readTenant(b.tenant)?.status === "active";
    try {
      if (wasOn) { state.message = `turning ${b.tenant} off…`; render(); await actions.stop(b.tenant); }
      const r = await silenced(() => restoreBackup({
        tenant: b.tenant, file: row.file, passphrase: passphrase || undefined, settings,
        onStep: (s) => { state.message = `restoring: ${s}…`; render(); },
      }));
      state.message = `✓ restored ${row.file}${r.safety ? ` · previous state: ${r.safety}` : ""}`;
      state.messageKind = "ok";
    } catch (e) {
      state.message = `restore failed: ${e.message}`; state.messageKind = "error";
    } finally {
      if (wasOn) await actions.start(b.tenant).catch(() => {});
      state.busy = false;
      await loadRows();
      await reloadBackups();
    }
  });
}

export function deleteSelected() {
  const b = B();
  const row = b.rows[b.cursor];
  if (!row) return;
  state.mode = "confirm";
  state.confirm = {
    question: `Delete ${row.file}${row.local && row.remote ? " (here and remote)" : ""}?`,
    onYes: async () => {
      try {
        await silenced(() => deleteBackup({ tenant: b.tenant, file: row.file, where: row.local && row.remote ? "both" : row.local ? "local" : "remote" }));
        state.message = `deleted ${row.file}`; state.messageKind = "ok";
      } catch (e) {
        state.message = e.message; state.messageKind = "error";
      }
      await reloadBackups();
    },
  };
  render();
}
