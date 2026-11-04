# Tests

```bash
yarn test # everything (unit + integration)
yarn test:unit # pure modules only, no tenant
node --test --test-force-exit test/integration/permissions.test.js   # one file
```

Built on `node:test` (no extra dependencies). Run from the repo root.

Besides the console, the same suite runs from:

- the **TUI** — `yarn tui`, then `T` (Tests tab): live per-file status, failures with their assertion diff, re-run failed files;
- the **Debugger** page in the desk (Tests tab) and its API, `POST /api/Debugger/runTests?suite=unit&wait=120` with a `run`-scope token — development mode only.

All three use `packages/loopar/core/debug/test-runner.js`: a child `node --test` with an NDJSON reporter (`test-reporter.js`), parsed into counts, per-file results and failures. After a run it removes any `sites/__loopar_test_*__` tenant the run left behind.

- `unit/` — pure modules (helpers, validators, the Op → SQL translator on an in-memory SQLite).
- `integration/` — a real tenant: `bootTestTenant()` (`support/tenant.js`) creates
  `sites/__loopar_test_<pid>__` with SQLite, installs the `loopar` app through its
  Installer (the same path a new site takes) and removes it in `teardown()`.
  Code that touches the tenant runs inside `t.run(() => …)`.

```js
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { loopar } from "loopar";
import { bootTestTenant } from "../support/tenant.js";

let t;
before(async () => { t = await bootTestTenant(); });
after(async () => { await t?.teardown(); });

test("…", () => t.run(async () => {
  assert.equal(await loopar.db.count("App", { name: "loopar" }), 1);
}));
```

CI: `.github/workflows/tests.yml` runs `yarn test` on every push and pull request.
