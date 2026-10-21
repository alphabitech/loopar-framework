# Tests

```bash
yarn test # everything (unit + integration)
yarn test:unit # pure modules only, no tenant
node --test --test-force-exit test/integration/permissions.test.js   # one file
```

Built on `node:test` (no extra dependencies). Run from the repo root.

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
