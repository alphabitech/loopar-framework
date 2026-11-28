/**
 * Tenant actions + the wizard/confirm flows. Orchestration comes from
 * tenant-ops.js — the SAME shared lifecycle the TenantManager entity (Desk UI /
 * control plane) uses — so every surface manages tenants identically.
 */
import { spawn } from "child_process";
import "loopar/bin/pm2-home.js";
import { tenantList, isLocalDomain } from "loopar/bin/tenant/tenant-builder.js";
import * as tenantOps from "loopar/bin/tenant/tenant-ops.js";
import { coreEnv, setCoreMode, corePort } from "loopar/core/config/core-config.js";
import { distIsReady } from "loopar/core/server/runtime-mode.js";
import { withPm2, restartCoreProcess, coreProcessStatus, CORE_PROCESS_NAME } from "loopar/bin/pm2.js";
import { silenced, quit } from "./term.js";
import { state, NO_PM2 } from "./state.js";
import { render } from "./render.js";
import { openLogs } from "./logs.js";
import { forgetBackups } from "./backups.js";
import { working, allowedWhileWorking } from "./working.js";
import { notice, errText } from "./notice.js";

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
      // All tenant domains route to the CORE via Caddy's catch-all. When
      // Caddy doesn't route a local domain (not installed, down), the core
      // answers it on its own port: <name>.localhost:<port>.
      const routed = !!caddy?.hosts.has(t.domain);
      const url = routed
        ? (caddy.port !== 80 ? `http://${t.domain}:${caddy.port}/desk` : `http://${t.domain}/desk`)
        : (isLocalDomain(t.domain) ? `http://${t.domain}:${corePort()}/desk` : `http://${t.domain}/desk`);
      return {
        name: t.name,
        domain: t.domain,
        url,
        status: t.online ? "online" : "stopped",
        controlPlane: t.controlPlane,
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
    return `${name} destroyed (database dropped, sites/${name} removed)`;
  },

  async controlPlane(name, on) {
    await tenantOps.setControlPlane(name, on);
    return on
      ? `${name} is now a control plane (applies on its next request)`
      : `${name} is no longer a control plane`;
  },

  async reset(name) {
    const dialect = await silenced(() => tenantOps.resetTenant(name));
    return `${name} reset (${dialect} database dropped) — opens the setup wizard on next request`;
  },
};

async function execute(action, name, ...args) {
  state.busy = true; render();
  try {
    const msg = await actions[action](name, ...args);
    // Quick actions report success in the status line; failures in a notice.
    if (/fail|not found/i.test(msg)) notice(msg, "error");
    else { state.message = msg; state.messageKind = "ok"; }
  } catch (err) {
    notice(errText(err), "error");
  }
  await loadRows();
  state.busy = false;
  render();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CORE_READY_MS = 45_000;

/**
 * After a restart pm2 says "online" long before the core serves: wait until
 * its port answers anything (any HTTP status counts), or give up.
 */
async function waitForCore() {
  const url = `http://127.0.0.1:${corePort()}/`;
  const until = Date.now() + CORE_READY_MS;
  while (Date.now() < until) {
    try {
      await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(1500) });
      return;
    } catch { await sleep(500); }
  }
  throw new Error(`the server restarted but :${corePort()} does not answer yet — see Logs`);
}

/** Restart the core process and wait until it serves. */
async function restartCore(step) {
  step("Restarting the core process");
  await silenced(() => withPm2(() => restartCoreProcess()));
  step(`Waiting for :${corePort()} to answer`);
  await waitForCore();
}

async function restartServer(title = "Restarting the server") {
  try {
    await working(title, restartCore);
    notice(`The server is up and answers on :${corePort()}.`, "ok", "Server");
  } catch (err) {
    notice(errText(err), "error", "Server");
  }
  await loadRows();
  return render();
}

export async function run(action) {
  const sel = state.rows[state.selected];

  if (action === "quit") return quit();
  // One blocking operation at a time (its modal may be hidden: see working.js).
  if (state.working && !allowedWhileWorking(action)) {
    notice(`${state.working.title} is still running. Wait for it to finish.`, "info");
    return render();
  }
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
        title: `New tenant · ${data.name}`,
        question: `Create "${data.name}" — turn it on now?`,
        onYes: () => createTenant(data, true),
        onNo: () => createTenant(data, false),
      };
      render();
    });
  }
  if (action === "destroy" || action === "reset") {
    if (!sel) return;
    try {
      tenantOps.assertDisposable(sel.name);
      tenantOps.assertStopped(sel.name, action);
    }
    catch (err) { notice(errText(err), "warn", `${action === "reset" ? "Reset" : "Destroy"} · ${sel.name}`); return render(); }
    state.mode = "destroy"; state.danger = action; state.input = ""; state.message = "";
    return render();
  }

  if (action === "logs-all") return openLogs(null);

  // Grant/revoke the control plane (Tenant Manager access + reset/destroy
  // protection). The server-side shell is the only place that can grant the
  // first one; the Desk can't touch its own flag.
  if (action === "control-plane") {
    if (!sel) return;
    const on = !sel.controlPlane;
    try { tenantOps.assertControlPlaneChange(sel.name, on); }
    catch (err) { notice(errText(err), "warn", `Control plane · ${sel.name}`); return render(); }
    state.mode = "confirm";
    state.confirm = {
      title: `Tenant · ${sel.name}`,
      question: on
        ? `Grant the control plane to "${sel.name}"? It will manage every tenant.`
        : `Revoke the control plane from "${sel.name}"?`,
      onYes: () => execute("controlPlane", sel.name, on),
    };
    return render();
  }

  // GLOBAL: bring the server (core process) up — the header's "press c" when
  // it is down. Not tied to a selected tenant; the core serves them all.
  if (action === "core") return restartServer("Starting the server");

  // GLOBAL: Restart = restart the server. There is one core process for every
  // tenant, so a per-tenant restart no longer exists (tenantOps.reload only
  // re-asserted `active`).
  if (action === "restart") {
    state.mode = "confirm";
    state.confirm = {
      title: "Server",
      question: "Restart the server? Every tenant disconnects for a moment.",
      onYes: () => restartServer(),
    };
    return render();
  }

  if (!sel) return;

  if (action === "logs") return openLogs(CORE_PROCESS_NAME);

  if (action === "open") {
    if (!sel.url) {
      notice(`${sel.name} has no URL.`, "error");
      return render();
    }
    // Clicking a dead tenant's URL would only show a connection error in the
    // browser — offer to bring it up first, then open. One click + Enter.
    if (sel.status === "stopped" || sel.status === "errored") {
      state.mode = "confirm";
      state.confirm = {
        title: `Tenant · ${sel.name}`,
        question: `"${sel.name}" is off — turn it on and open?`,
        onYes: async () => {
          state.busy = true; render();
          try {
            const msg = await actions.start(sel.name);
            if (/fail/i.test(msg)) notice(msg, "error");
            else { state.message = msg; state.messageKind = "ok"; openUrl(sel.url); }
          } catch (err) {
            notice(errText(err), "error");
          }
          await loadRows();
          state.busy = false;
          render();
        },
      };
      return render();
    }
    const ok = openUrl(sel.url);
    if (ok) { state.message = `opening ${sel.url}`; state.messageKind = "ok"; }
    else notice(`Could not launch a browser. Open ${sel.url} yourself.`, "error");
    return render();
  }

  // GLOBAL core mode switch (dev/prod). Writes config/core.json and restarts
  // the core process — every tenant disconnects briefly.
  if (action === "mode") {
    const cur = coreEnv();
    const next = cur === "production" ? "development" : "production";
    if (next === "production" && !distIsReady()) {
      notice("No build found. Run `yarn build` (or Deploy) before switching to production.", "warn", "Production");
      return render();
    }
    state.mode = "confirm";
    state.confirm = {
      title: "Server",
      question: `Switch the server from ${cur} to ${next} and restart it? Every tenant disconnects for a moment.`,
      onYes: async () => {
        try {
          await working(`Switching the server to ${next}`, async (step) => {
            step(`Writing config/core.json (${next})`);
            setCoreMode(next);
            await restartCore(step);
          });
          notice(`The server runs in ${next} and answers on :${corePort()}.`, "ok", "Server");
        } catch (err) {
          notice(errText(err), "error", "Server");
        }
        await loadRows();
        render();
      },
    };
    return render();
  }

  // stop/unregister take a serving tenant offline — ask first.
  // start is additive and runs directly.
  if (["stop", "unregister"].includes(action)) {
    state.mode = "confirm";
    state.confirm = {
      title: `Tenant · ${sel.name}`,
      question: `Turn off "${sel.name}"? Its site shows the suspended page until you start it again. Other tenants are not affected.`,
      onYes: () => execute(action, sel.name),
    };
    return render();
  }

  return execute(action, sel.name);
}

/**
 * Open the modal wizard. `opts`: { body, submitLabel, submitColor, border } —
 * explanatory text above the field, the last step's button and the colors
 * (defaults: the New-tenant look).
 */
export function openWizard(title, steps, onDone, opts = {}) {
  state.mode = "create";
  state.message = "";
  state.wizard = { title, steps, idx: 0, onDone, ...opts };
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
  try {
    const created = await working(`Creating ${data.name}`, async (step) => {
      step(`Creating sites/${data.name} and its database`);
      const done = await silenced(() => tenantOps.createTenant(
        { name: data.name, port: data.port, domain: data.domain || undefined },
        { activate: startAfter }
      ));
      if (startAfter) step(`Turning ${data.name} on`);
      return done;
    });
    const base = startAfter
      ? `${data.name} was created and turned on.`
      : `${data.name} was created. It is off: press Start to turn it on.`;
    // Remote tenants: show the tokened install link once (also in config.json).
    notice(created?.installUrl ? `${base} Install it at ${created.installUrl}` : base, "ok", `New tenant · ${data.name}`);
  } catch (err) {
    notice(errText(err), "error", `New tenant · ${data.name}`);
  }
  await loadRows();
  const i = state.rows.findIndex((r) => r.name === data.name);
  if (i >= 0) state.selected = i;
  render();
}

export async function submitModal() {
  const name = state.input.trim();
  const target = state.rows[state.selected]?.name;
  const action = state.danger === "reset" ? "reset" : "destroy";
  state.mode = "list"; state.danger = null;
  if (name !== String(target || "").toLowerCase()) {
    notice(`The name did not match "${target}": nothing was ${action === "reset" ? "reset" : "destroyed"}.`, "warn", `${action === "reset" ? "Reset" : "Destroy"} cancelled`);
    return render();
  }
  try {
    const done = await working(`${action === "reset" ? "Resetting" : "Destroying"} ${target}`, (step) => {
      step(action === "reset"
        ? `Dropping ${target}'s database`
        : `Dropping ${target}'s database and removing sites/${target}`);
      return actions[action](target);
    });
    notice(done, "ok", `${action === "reset" ? "Reset" : "Destroy"} · ${target}`);
    if (action === "destroy") forgetBackups(target);
  } catch (err) {
    notice(errText(err), "error", `${action === "reset" ? "Reset" : "Destroy"} · ${target}`);
  }
  await loadRows();
  render();
}
