import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loopar, CoreInstaller } from "loopar";
import { bootTestTenant } from "../support/tenant.js";

/*
 * An app must never take over a record another installed app owns. Entities
 * were already guarded; inline documents (e.g. "Module:mail") were not: an app
 * shipping a module with the same name re-saved loopar's module with its own
 * data and moved it — and every entity in it — to that app.
 */

const APP = `__own_test_${process.pid}__`;
const appDir = path.join(process.cwd(), "apps", APP);

function writeInstaller(extra = {}) {
  fs.mkdirSync(path.join(appDir, "modules", `${APP}-own`), { recursive: true });
  fs.writeFileSync(path.join(appDir, "installer.json"), JSON.stringify({
    App: { name: APP, version: "0.0.1" },
    documents: {
      "Entity:App": { __app__: "loopar" },
      "Entity:Module": { __app__: "loopar" },
      [`App:${APP}`]: { name: APP, version: "0.0.1", has_website: 0, autor: "test@loopar.test" },
      [`Module:${APP}-own`]: { name: `${APP}-own`, description: "Own module", app_name: APP, in_sidebar: 1 },
      ...extra,
    },
  }, null, 2));
}

let t;
before(async () => { t = await bootTestTenant(); });
after(async () => {
  await t?.teardown();
  fs.rmSync(appDir, { recursive: true, force: true });
});

const install = (reinstall = false) => t.run(() => new CoreInstaller({ app_name: APP }).install(reinstall));

test("an app cannot take over a module another installed app ships", async () => {
  writeInstaller({ "Module:mail": { name: "mail", description: "Hijack", app_name: APP, in_sidebar: 1 } });
  await assert.rejects(install(), /already belong to another app.*Module:mail \(owned by "loopar"\)/s);

  await t.run(async () => {
    assert.equal((await loopar.db.getRow("Module", "mail", ["app_name"])).app_name, "loopar");
    assert.equal(await loopar.db.count("App", { name: APP }), 0, "refused before writing anything");
  });
});

test("the same app installs once the colliding entry is gone, and updates keep its own records", async () => {
  writeInstaller();
  await install();
  await install(true);
  await t.run(async () => {
    assert.equal((await loopar.db.getRow("Module", `${APP}-own`, ["app_name"])).app_name, APP);
    assert.equal((await loopar.db.getRow("Module", "mail", ["app_name"])).app_name, "loopar");
  });
});
