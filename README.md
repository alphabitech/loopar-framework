# Loopar

**Design your app in the browser, ship the full stack.** Loopar is a multi-tenant, drag-and-drop web framework: you model entities, pages and forms visually and it scaffolds the database model, the controller and the rendered views for you.

`v7.0.0` · MIT · Node 22.12+ · React (SSR + hydration), Vite 8 (Rolldown), single-core multi-tenant.

> 📖 **Full documentation:** the `loopar-webpage` app and **[loopar.build/Doc](https://loopar.build/Doc)**.

---

## Prerequisites

- Node.js **22.12+**
- Yarn **4+** (required — npm/pnpm are not supported)

> No Yarn 4? Enable it via Corepack (bundled with Node 16.9+):
>
> ```shell
> corepack enable
> yarn set version stable
> ```



## Install

**With NPX (fastest):**

```shell
npx loopar-install project-name --port 8080
```

The dev server starts automatically.

**From Git:**

```shell
git clone https://github.com/alphabit-technology/loopar-framework.git project-name
cd project-name
yarn install
yarn start
```

`yarn start` opens the **TUI** (interactive tenant manager). On a fresh install — a single stopped `dev` tenant — it starts it automatically; press `o` (or click the URL) to open `http://localhost:3000`.

## First run

The browser shows a setup wizard: pick your **database** and connection, then your **project** data. When it finishes you land in the Desk, where you design your app visually — everything else is in the [docs](https://loopar.build/Doc).

---



# Commands

All commands run through the project-local pm2 daemon (isolated `PM2_HOME`). Use `yarn <command>` or `node bin/cli/index.js <command>`.

> One tenant-less **core** process serves every tenant in-process. `dev`/`prod` is a **global** core switch (`config/core.json` → `nodeEnv`), toggled from the TUI (`[p]`) or with `yarn prod` — not a per-tenant or per-command mode. Tenants are turned on/off individually (their `status` in `sites/<name>/config.json`), not started as separate processes.



## Scripts at a glance

Most days you only need `start` and `logs`. The rest are situational, grouped by intent:

- **Local:** `start` opens the TUI (manage tenants, switch dev/prod, tail logs) — `tui` is the same command. `logs` tails outside the TUI.
- **Run headless:** `serve` boots the core in the configured mode (servers / pm2 / CI); `prod` sets production (guards that a build exists) then boots.
- **Tenants:** `tenant <on|off|list>` turns a tenant on or off.
- **Build & deploy:** `build` is a full rebuild. For fast iteration use `watch` (keeps building `build/staging` in the background) + `activate` (promotes staging to live). `build:client` / `build:server` are the two halves `build` runs — rarely invoked alone.
- **pm2 lifecycle:** `stop`, `restart`, `kill`; `startup` registers a reboot hook (run once, on servers).
- **Maintenance:** `migrate` converts a legacy `sites/<t>/.env` to `config.json` (one-shot); `deps` does a reproducible install. `preinstall` / `postinstall` run automatically on `yarn install`.



## Lifecycle


| Command                            | Description                                                                                                     |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `yarn start`                       | Open the TUI — the interactive tenant manager (same as `yarn tui`)                                              |
| `yarn serve`                       | Headless boot of the core in the mode `config/core.json` says (for servers/scripts/pm2)                         |
| `yarn prod`                        | Set the core to **production** (guards that a build exists) and boot it                                         |
| `yarn tenant <on|off|list> [name]` | Turn a tenant on/off or list them (same as the TUI / Desk)                                                      |
| `yarn stop [site]`                 | Stop one tenant, or everything running in the project namespace                                                 |
| `yarn restart [site]`              | With a site: delete + fresh start (picks up `.env` changes). No argument: in-place restart of running processes |
| `yarn delete [site]`               | Remove processes from the pm2 registry                                                                          |
| `yarn kill`                        | Kill processes AND the daemon (clean slate)                                                                     |
| `yarn startup`                     | Register a reboot-safe boot hook (run once after first deploy)                                                  |


Tenants are resolved the same way the Tenant Manager UI does (`tenant-builder`): process name = tenant id, config built from the tenant's `.env`. The CLI and the UI manage the same processes interchangeably.

## Interactive TUI

```shell
yarn start      # or: yarn tui
```

A full tenant manager in your terminal, with mouse support (click rows and buttons, scroll with the wheel) and keyboard shortcuts. It shows every tenant in `sites/` with live pm2 status and offers per-tenant actions:

- **Start / Stop / Restart** — stop and restart ask for confirmation; starting a tenant with a `DOMAIN` also registers its Caddy route, exactly like the Desk UI.
- **Open** — launch the selected tenant's URL in your browser (key `o`, click the URL cell, or double-click the row). Tenant names are OSC 8 hyperlinks (Cmd/Ctrl+click) in terminals that support them. When Caddy routes the domain, the URL drops the port (`http://dev.localhost`); otherwise it targets the tenant port directly.
- **Backups** — key `B` (or the BACKUPS tab): the selected tenant's backups (local and remote), back up now, restore in place or as a new tenant, delete.
- **Tests** — key `T` (or the TESTS tab) runs the test suite in a child process with live results: per-file status, pass/fail counts, each failure with its assertion diff and the output. `a` all · `u` unit · `i` integration · space picks files, Enter runs them · `f` re-runs the failed files · `x` stops.
- **Logs** — key `l` / Tab switches to a full-screen realtime log stream of the selected tenant: recent history from the pm2 log files, then live lines via the pm2 event bus (the same mechanism `pm2 logs` uses) with timestamps, stderr in red. Arrows/wheel scroll (pauses following), `f` resumes.
- **Prod/dev** — key `p` switches the **core's** mode (`config/core.json` → `nodeEnv`, with confirmation) and restarts the core process, so cluster/fork mode and prebuilt-dist vs Vite serving actually apply. It's a global switch, not per-tenant.
- **New** — guided wizard: name, auto-allocated free port, domain — with optional immediate start.
- **Unregister** — remove from the pm2 registry (files stay on disk).
- **Destroy** — full teardown (pm2 + Caddy route + `sites/<name>/`); requires typing the tenant name to confirm.

First-boot fast path: when there is exactly one tenant and it's stopped (the state right after a fresh install), the TUI starts it automatically on open — `yarn install && yarn start` lands on a running site with zero decisions. With several tenants it never starts anything on its own.

The TUI, the CLI and the Tenant Manager UI all share the same underlying layer (`tenant-builder` + `tenant-service`), so they manage the same processes interchangeably. It runs in "bare mode" — no tenant, Entity or database needed — which makes it the rescue tool of choice when a tenant won't boot. Use `node bin/tui/index.js --list` for a JSON dump in scripts.

## Inspection


| Command            | Description                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------- |
| `yarn tui`         | Interactive tenant manager: statuses, start/stop, create, destroy, backups, tests                 |
| `yarn logs [site]` | Tail logs for all sites or one                                                                    |
| `yarn test`        | Unit + integration tests (`node:test`); `yarn test:unit` for the fast ones — see `test/README.md` |


