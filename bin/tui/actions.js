/**
 * Tenant actions + the wizard/confirm flows. Orchestration comes from
 * tenant-ops.js — the SAME shared lifecycle the TenantManager entity (Desk UI /
 * control plane) uses — so every surface manages tenants identically.
 */
import { spawn } from "child_process";
import "loopar/bin/pm2-home.js";
import { tenantList } from "loopar/bin/tenant/tenant-builder.js";
import * as tenantOps from "loopar/bin/tenant/tenant-ops.js";
import { coreEnv, setCoreMode } from "loopar/core/config/core-config.js";
import { distIsReady } from "loopar/core/server/runtime-mode.js";
import { withPm2, restartCoreProcess, coreProcessStatus, CORE_PROCESS_NAME } from "../cli/pm2.js";
import { silenced, quit } from "./term.js";
import { state, NO_PM2 } from "./state.js";
import { render } from "./render.js";
import { openLogs } from "./logs.js";

let caddyState = null;

async function probeCaddy() {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 400);
    const res = await fetch("http://localhost:2019/config/apps/http/servers/srv0", { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return caddyState;
    const srv = await res.json();
    const listen = Array.isArray(srv?.listen) ? srv.listen[0] : ":80";
    const m = String(listen || "").match(/:(\d+)$/);
    const hosts = new Set();
    for (const route of srv?.routes || []) {
      for (const match of route.match || []) {
        for (const h of match.host || []) hosts.add(h);
      }
    }
    caddyState = { port: m ? Number(m[1]) : 80, hosts };
  } catch (_) { /* Caddy down/unreachable — keep last known state */ }
  return caddyState;
}

export async function loadRows(withStatus = true) {
  const caddy = withStatus ? await probeCaddy() : caddyState;

  if (withStatus && !NO_PM2) {
    try { state.coreStatus = await coreProcessStatus(); }
    catch { /* keep last known */ }
  }

  const all = tenantList()
    .map((t) => {
      // All tenant domains route to the CORE via Caddy's catch-all.
      const viaCaddy = caddy?.hosts.has(t.domain) && caddy.port !== 80
        ? `http://${t.domain}:${caddy.port}/desk`
        : `http://${t.domain}/desk`;
      return {
        name: t.name,
        domain: t.domain,
        url: viaCaddy,
        status: t.online ? "online" : "stopped",
      };
    })
    .sort((a, b) => (b.name === "dev") - (a.name === "dev") || a.name.localeCompare(b.name));

  state.rows = all;
  if (state.selected >= all.length) state.selected = Math.max(0, all.length - 1);
}

// ─── Open in browser ────────────────────────────────────────────────────────

// The TUI owns the mouse (SGR tracking).
export function openUrl(url) {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]] :
    process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] :
    ["xdg-open", [url]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
    return true;
  } catch (_) {
    return false;
  }
}

export const actions = {
  start: (name) => silenced(async () => {
    const suffix = await tenantOps.activate(name);
    return `${name} turned on${suffix}`;
  }),

  stop: (name) => silenced(async () => {
    await tenantOps.suspend(name);
    return `${name} suspended`;
  }),

  restart: (name) => silenced(async () => {
    await tenantOps.reload(name);
    return `${name} reloaded (applies on next request)`;
  }),

  // Suspend alias kept for the old "unregister" keybinding.
  unregister: (name) => silenced(async () => {
    await tenantOps.suspend(name);
    return `${name} suspended`;
  }),

  async destroy(name) {
    await silenced(() => tenantOps.destroyTenant(name, { removePath: true }));
    return `${name} destroyed (sites/${name} removed)`;
  },
};

async function execute(action, name) {
  state.busy = true; render();
  try {
    const msg = await actions[action](name);
    state.message = msg;
    state.messageKind = /fail|not found/i.test(msg) ? "error" : "ok";
  } catch (err) {
    state.message = err.message || String(err);
    state.messageKind = "error";
  }
  await loadRows();
  state.busy = false;
  render();
}

export async function run(action) {
  const sel = state.rows[state.selected];

  if (action === "quit") return quit();
  if (action === "refresh") {
    state.busy = true; render();
    await loadRows();
    state.busy = false; state.message = "refreshed"; state.messageKind = "info";
    return render();
  }
  if (action === "new") {
    return openWizard("New tenant", [
      { key: "name", label: "name", value: "", validate: (v) => /^[a-z0-9][a-z0-9-]*$/.test(v) || "Invalid name (a-z, 0-9, dashes)" },
      { key: "domain", label: "domain", default: (d) => `${d.name}.localhost`, validate: (v) => v === "" || /^[a-z0-9][a-z0-9.-]*$/.test(v) || "Invalid domain" },
    ], (data) => {
      state.mode = "confirm";
      state.confirm = {
        question: `Create "${data.name}" — turn it on now?`,
        onYes: () => createTenant(data, true),
        onNo: () => createTenant(data, false),
      };
      render();
    });
  }
  if (action === "destroy") {
    if (!sel) return;
    state.mode = "destroy"; state.input = ""; state.message = "";
    return render();
  }

  if (action === "logs-all") return openLogs(null);

  // GLOBAL: bring the core (generator) up / restart it — the header's "press c".
  // Not tied to a selected tenant; the core serves them all.
  if (action === "core") {
    state.busy = true; render();
    try {
      await silenced(() => withPm2(() => restartCoreProcess()));
      state.message = "core (re)started";
      state.messageKind = "ok";
    } catch (err) {
      state.message = err.message || String(err);
      state.messageKind = "error";
    }
    await loadRows();
    state.busy = false;
    return render();
  }

  if (!sel) return;

  if (action === "logs") return openLogs(CORE_PROCESS_NAME);

  if (action === "open") {
    if (!sel.url) {
      state.message = "no URL for this tenant"; state.messageKind = "error";
      return render();
    }
    // Clicking a dead tenant's URL would only show a connection error in the
    // browser — offer to bring it up first, then open. One click + Enter.
    if (sel.status === "stopped" || sel.status === "errored") {
      state.mode = "confirm";
      state.confirm = {
        question: `"${sel.name}" is off — turn it on and open?`,
        onYes: async () => {
          state.busy = true; render();
          try {
            const msg = await actions.start(sel.name);
            state.message = msg;
            state.messageKind = /fail/i.test(msg) ? "error" : "ok";
            if (!/fail/i.test(msg)) openUrl(sel.url);
          } catch (err) {
            state.message = err.message || String(err);
            state.messageKind = "error";
          }
          await loadRows();
          state.busy = false;
          render();
        },
      };
      return render();
    }
    const ok = openUrl(sel.url);
    state.message = ok ? `opening ${sel.url}` : "could not launch a browser";
    state.messageKind = ok ? "ok" : "error";
    return render();
  }

  // GLOBAL core mode switch (dev/prod). Writes config/core.json and restarts
  // the core process — every tenant disconnects briefly.
  if (action === "mode") {
    const cur = coreEnv();
    const next = cur === "production" ? "development" : "production";
    if (next === "production" && !distIsReady()) {
      state.message = "No build found — run `yarn build` (or Deploy) before production";
      state.messageKind = "error";
      return render();
    }
    state.mode = "confirm";
    state.confirm = {
      question: `Switch the CORE ${cur} → ${next} and restart? All tenants disconnect briefly.`,
      onYes: async () => {
        state.busy = true; render();
        try {
          setCoreMode(next);
          await silenced(() => withPm2(() => restartCoreProcess()));
          state.message = `core → ${next} (restarted)`;
          state.messageKind = "ok";
        } catch (err) {
          state.message = err.message || String(err);
          state.messageKind = "error";
        }
        await loadRows();
        state.busy = false;
        render();
      },
    };
    return render();
  }

  // stop/restart/unregister change a serving tenant — ask first.
  // start is additive and runs directly.
  if (["stop", "restart", "unregister"].includes(action)) {
    state.mode = "confirm";
    state.confirm = {
      question: `${action[0].toUpperCase() + action.slice(1)} tenant "${sel.name}"?`,
      onYes: () => execute(action, sel.name),
    };
    return render();
  }

  return execute(action, sel.name);
}

export function openWizard(title, steps, onDone) {
  state.mode = "create";
  state.message = "";
  state.wizard = { title, steps, idx: 0, onDone };
  state.input = steps[0].value || "";
  render();
}

const collectedWizard = (w) =>
  Object.fromEntries(w.steps.map((s) => [s.key, s.value]));

export function advanceWizard() {
  const w = state.wizard;
  if (!w) return;
  const st = w.steps[w.idx];
  const v = state.input.trim();
  const valid = st.validate ? st.validate(v, collectedWizard(w)) : true;
  if (valid !== true) {
    state.message = valid; state.messageKind = "error";
    return render();
  }
  st.value = v;
  state.message = "";
  if (w.idx < w.steps.length - 1) {
    w.idx++;
    const next = w.steps[w.idx];
    if (!next.value && next.default) next.value = next.default(collectedWizard(w));
    state.input = next.value || "";
    return render();
  }
  state.wizard = null;
  state.mode = "list";
  w.onDone(collectedWizard(w));
}

async function createTenant(data, startAfter) {
  state.busy = true; render();
  try {
    const created = await tenantOps.createTenant(
      { name: data.name, port: data.port, domain: data.domain || undefined },
      { activate: startAfter }
    );
    const base = startAfter
      ? `${data.name} created and turned on`
      : `${data.name} created (off — press Start to turn on)`;
    // Remote tenants: show the tokened install link once (also in config.json).
    state.message = created?.installUrl
      ? `${base} — install: ${created.installUrl}`
      : base;
    state.messageKind = "ok";
  } catch (err) {
    state.message = err.message || String(err);
    state.messageKind = "error";
  }
  await loadRows();
  state.busy = false;
  const i = state.rows.findIndex((r) => r.name === data.name);
  if (i >= 0) state.selected = i;
  render();
}

export async function submitModal() {
  const name = state.input.trim();
  const target = state.rows[state.selected]?.name;
  state.mode = "list";
  if (name !== target) {
    state.message = "Destroy cancelled (name did not match)"; state.messageKind = "info";
    return render();
  }
  state.busy = true; render();
  try {
    state.message = await actions.destroy(target);
    state.messageKind = "ok";
  } catch (err) {
    state.message = err.message; state.messageKind = "error";
  }
  await loadRows();
  state.busy = false;
  render();
}
