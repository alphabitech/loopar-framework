# Loopar

**Design your app in the browser, ship the full stack.** Loopar is a multi-tenant, drag-and-drop web framework: you model entities, pages and forms visually and it scaffolds the database model, the controller and the rendered views for you.

`v7.0.0` · MIT · Node 22.12+ · React (SSR + hydration), Vite 8 (Rolldown), single-core multi-tenant.

> 📖 **Full documentation:** the `loopar-webpage` app and **[loopar.build/Doc](https://loopar.build/Doc)**.

---

## Prerequisites

- Node.js **22.12+**
- Yarn **4+** (required — npm/pnpm are not supported)

> No Yarn 4? Enable it via Corepack (bundled with Node 16.9+):
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

| Command               | Description                                                                                                     |
| --------------------- | --------------------------------------------------------------------------------------------------------------- |
| `yarn start`          | Open the TUI — the interactive tenant manager (same as `yarn tui`)                                              |
| `yarn serve`          | Headless boot of the core in the mode `config/core.json` says (for servers/scripts/pm2)                        |
| `yarn prod`           | Set the core to **production** (guards that a build exists) and boot it                                         |
| `yarn tenant <on\|off\|list> [name]` | Turn a tenant on/off or list them (same as the TUI / Desk)                                       |
| `yarn stop [site]`    | Stop one tenant, or everything running in the project namespace                                                 |
| `yarn restart [site]` | With a site: delete + fresh start (picks up `.env` changes). No argument: in-place restart of running processes |
| `yarn delete [site]`  | Remove processes from the pm2 registry                                                                          |
| `yarn kill`           | Kill processes AND the daemon (clean slate)                                                                     |
| `yarn startup`        | Register a reboot-safe boot hook (run once after first deploy)                                                  |

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

| Command            | Description                                                       |
| ------------------ | ----------------------------------------------------------------- |
| `yarn tui`         | Interactive tenant manager: statuses, start/stop, create, destroy, backups, tests |
| `yarn logs [site]` | Tail logs for all sites or one                                    |
| `yarn test`        | Unit + integration tests (`node:test`); `yarn test:unit` for the fast ones — see `test/README.md` |

## Debugger

`/desk/Debugger/view` (module **debug**, also in the apps menu and as the bug chip in the desk header) is a Yii-debug style view of what the framework did for the tenant you are on:

- **Requests** — every request routed to a controller: route, user, status, timing, redacted params/headers, every SQL statement with its timing and (redacted) bindings, what it logged, what failed. Repeated statements (possible N+1) and identical duplicates are flagged.
- **Database** — statements by total time, slowest runs, failed queries and queries that ran outside a request.
- **Logs / Errors** — the tenant's console output and the errors it raised (5xx and 4xx), with stacks.
- **Status** — versions, mode, build, memory, DB, installed apps with pending updates.
- **Tests** — run the suite (all, unit, integration or picked files) and follow it live. Development mode only.
- **API access** — bearer tokens for agents and scripts.

The page doesn't poll: new requests, logs, errors and test progress are pushed over the realtime socket on a `debug` channel that only users allowed to open the Debugger can join.

The data is kept in memory by the core (`packages/loopar/core/debug`), bounded per tenant and lost on restart; a tenant only ever sees its own. It records **by default in development and is off in production** — set `"debug": true` in `config/core.json` (or `LOOPAR_DEBUG=1`) and restart to turn it on there. Passwords, tokens, secrets and cookies are redacted before anything is stored.

### API (for agents)

Everything above is JSON under `/api/Debugger/<action>`. Create a token in **Debugger → API access** (scope `read`, or `run` to also start test runs) and start from the manifest, which lists every endpoint with its parameters:

```shell
curl -s https://<tenant-domain>/api/Debugger/manifest -H "Authorization: Bearer ldbg_…"
curl -s "https://<tenant-domain>/api/Debugger/requests?status=5xx" -H "Authorization: Bearer ldbg_…"
curl -s -X POST "https://<tenant-domain>/api/Debugger/runTests?suite=unit&wait=120" -H "Authorization: Bearer ldbg_…"
```

Every response of the tenant carries `X-Loopar-Debug: <requestId>`: call any endpoint, then `GET /api/Debugger/request?id=<requestId>` to read its SQL, logs and errors. A token authenticates only on these endpoints — it never acts as a user anywhere else.

## Backups

`/desk/Backups/view` (module **backup**, also in the apps menu) backs up the tenant you are on: its database plus `sites/<tenant>/` (config, uploads, theme). App code is not included — apps come from their own repositories.

- **Schedule** — *Backup Settings*: hourly, daily or weekly at a given time; the core's scheduler runs it (`apps/loopar/jobs.js`). Retention keeps the newest scheduled backup per day / week / month (7 / 4 / 3 by default), the last 10 manual ones and the last 5 safety snapshots. Uploaded archives are never pruned.
- **Safety snapshots** — taken automatically before an app is installed or updated (`pre-update`, at most one per 10 minutes) and before every restore (`pre-restore`). Local only.
- **Encryption** — AES-256-GCM with a passphrase (scrypt). On by default and required for remote destinations. The passphrase is stored encrypted with the tenant key; keep a copy elsewhere — without it a backup cannot be restored.
- **Destinations** — a copy of every archive goes to S3 or any S3-compatible storage (MinIO, R2, Spaces, B2), SFTP, WebDAV (Nextcloud…) or Google Drive (connect with your own OAuth client; scope `drive.file`). Local copies always stay in `backups/<tenant>/`.
- **Restore** — Administrator only, typing the site name to confirm. In place: the tenant answers 503 while its files and database are swapped, then re-initializes; if anything fails the previous state is put back. A downloaded archive can be uploaded (≤ 50 MB from the desk; larger ones with the CLI) and restored.

Archives are `backups/<tenant>/<tenant>__<UTC stamp>__<kind>.tar.gz[.enc]` with a `.json` sidecar (date, size, apps and versions, DB dialect — no secrets). SQLite uses its online backup; MySQL/MariaDB a logical dump; PostgreSQL needs `pg_dump` / `pg_restore` on the server. From the desk, a MySQL/PostgreSQL database is only restored from archives this server made (an archive from elsewhere replays SQL with the server's credentials): restore those with the CLI. Downloads, uploads and restores are for the Administrator only; SFTP private keys go in `config/backup-keys/`.

```shell
yarn backup create <tenant>|--all [--local]          # --local: skip the remote copy
yarn backup list <tenant>
yarn backup restore <tenant> <file> [--passphrase …] [--yes]   # tenant must be Off
yarn backup restore <tenant> <file> --as <new-tenant>         # SQLite: a new, suspended tenant
yarn backup delete <tenant> <file>
```

## Dependencies

| Command     | Description                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------------ |
| `yarn deps` | Install dependencies (`yarn install --immutable`). Decoupled from `build` so a deploy never triggers an implicit install |

## Build & Deploy

Two paths to production, both ending in an atomic release swap:

| Command         | Description                                                                                                                                                                                  |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `yarn build`    | Full build: prepare release → Vite client + server bundles (compressed) → activate                                                                                                           |
| `yarn watch`    | Warm watcher under pm2 (`build-watch` process): incremental rebuilds (~1s) of `apps/**/client/**` into `build/staging/`. Start it when preparing releases; stop with `yarn stop build-watch` |
| `yarn activate` | Snapshot `build/staging/` into a new release and activate it (fast deploy)                                                                                                                   |

Dev tenants serve through Vite middleware (HMR) and do **not** need the watcher — it exists only to keep `build/staging/` fresh for fast deploys.

From the Tenant Manager UI, the **Deploy** split-button maps to the same flows: click = deploy from staging (fast), dropdown = full rebuild & deploy. **Install** runs `yarn deps`.

### Release layout

```
dist -> build/releases/<tag>   # symlink; what the server actually serves
build/
  releases/<tag>/              # versioned, immutable releases (last 2 kept)
  staging/                     # mutable watcher output; snapshot source for fast deploys
```

Activation swaps the `dist` symlink atomically and `pm2 reload`s production tenants — no downtime window. Rollback is one command:

```shell
ln -sfn build/releases/<previous-tag> dist && yarn restart
```

### Build environment variables

| Variable               | Default  | Description                                            |
| ---------------------- | -------- | ------------------------------------------------------ |
| `BUILD_COMPRESS`       | `brotli` | Asset compression: `brotli` | `gzip` | `both` | `none` |
| `BUILD_BROTLI_QUALITY` | `9`      | Brotli quality (0–11)                                  |
| `BUILD_GZIP_LEVEL`     | `6`      | Gzip level (1–9)                                       |

# Project structure

```
apps/<app>/modules/...        # your applications (entities, controllers, client views)
packages/loopar/              # framework core (server, ORM, React components)
packages/vite-env/            # shared Vite config (client/server/watch builds)
sites/<tenant>/               # per-tenant config and data
bin/                          # cli/, tui/, build/, setup/
```

---

MIT © [Alphabit Technology](https://github.com/alphabit-technology)
