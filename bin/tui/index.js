#!/usr/bin/env node

/**
 * Loopar TUI — interactive tenant manager for the terminal.
 *
 * Same data source as the Tenant Manager UI and the CLI: tenants are read
 * PHYSICALLY from sites/<name>/config.json via tenant-builder.js, and the tenant
 * lifecycle comes from tenant-ops.js — the SAME shared ops the TenantManager
 * entity (Desk UI / control plane) uses. No tenant process, no Entity, no
 * database is needed to run this ("bare mode").
 *
 * Modules:
 *   term.js    ANSI, screen lifecycle, quit
 *   state.js   shared mutable state
 *   render.js  frame drawing + clickable regions (tenants + logs tabs)
 *   actions.js tenant actions, dispatcher, wizard/confirm flows
 *   logs.js    log-tail tab (fs tail of PM2_HOME/logs, no pm2 bus to read)
 *   tests.js   tests tab (node:test in a child process, live results)
 *   backups.js backups tab (list, back up, restore, delete — no framework needed)
 *   input.js   keyboard + SGR mouse decoding
 *
 * Usage:
 *   node bin/tui/index.js          interactive TUI (or: yarn start / yarn tui)
 *   node bin/tui/index.js --list   print tenants as JSON and exit (no TTY)
 *
 * Env:
 *   LOOPAR_TUI_NO_PM2=1   never touch PM2 (statuses show as "n/a")
 */

const IS_LIST = process.argv.includes("--list");
let bootTimer = null;

if (!IS_LIST && process.stdout.isTTY) {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  const draw = () =>
    process.stdout.write(`\r \x1b[36m${frames[i = (i + 1) % frames.length]}\x1b[0m \x1b[36m◆ LOOPAR\x1b[0m starting tenant manager… `);
  draw();
  bootTimer = setInterval(draw, 80);
}

await import("loopar/bin/pm2-home.js");
const { enterScreen, exitScreen, quit, silenced } = await import("./term.js");
const { state, NO_PM2 } = await import("./state.js");
const { render } = await import("./render.js");
const { loadRows, actions } = await import("./actions.js");
const { onData } = await import("./input.js");
const { withPm2, startCoreProcess, coreProcessStatus } = await import("../cli/pm2.js");

if (bootTimer) {
  clearInterval(bootTimer);
  process.stdout.write("\r\x1b[2K"); // clear the spinner line
}

async function main() {
  // Non-interactive mode for scripts / testing: --list prints JSON and exits.
  if (IS_LIST) {
    await loadRows();
    console.log(JSON.stringify(state.rows, null, 2));
    process.exit(0);
  }

  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    console.error("loopar-tui needs an interactive terminal (or use --list).");
    process.exit(1);
  }

  enterScreen();
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", onData);
  process.stdout.on("resize", render);
  process.on("SIGINT", () => quit());
  process.on("SIGTERM", () => quit());

  state.message = "loading tenants...";
  await loadRows(false);
  render();

  // Statuses arrive async so the UI paints instantly even if PM2 is cold.
  await loadRows();

  // Ensure the core is up. The TUI manages tenants, but a tenant only serves
  // while loopar-core is running — so opening the manager should also bring the
  // server up.
  if (!NO_PM2) {
    try {
      const status = await coreProcessStatus();
      if (status !== "online") {
        state.busy = true;
        state.message = "core is down — starting it…";
        render();
        await silenced(() => withPm2(() => startCoreProcess()));
        state.message = "core started";
        state.messageKind = "ok";
        state.busy = false;
        await loadRows();
      }
    } catch (err) {
      state.busy = false;
      state.message = `core start failed: ${err.message || err}`;
      state.messageKind = "error";
    }
  }

  // First-boot fast path: exactly one tenant and it's stopped — the state
  // right after a fresh install (ensure-site creates `dev`)
  if (!NO_PM2 && state.rows.length === 1 && state.rows[0].status === "stopped") {
    const only = state.rows[0];
    state.busy = true;
    state.message = `only tenant is stopped — starting ${only.name}...`;
    render();
    try {
      const msg = await actions.start(only.name);
      state.message = msg;
      state.messageKind = /fail/i.test(msg) ? "error" : "ok";
    } catch (err) {
      state.message = err.message || String(err);
      state.messageKind = "error";
    }
    await loadRows();
    state.busy = false;
  } else {
    state.message = "ready · [o] open · [l] logs · [L] all logs · [T] tests · [B] backups · [p] prod/dev";
    state.messageKind = "info";
  }
  render();

  // Keep statuses fresh (the logs tab has its own poll in logs.js).
  setInterval(async () => {
    if (state.busy || state.mode !== "list" || state.view !== "tenants") return;
    await loadRows();
    render();
  }, 4000);
}

main().catch((err) => {
  exitScreen();
  console.error(err);
  process.exit(1);
});
