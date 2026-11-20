import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loopar, portalProvider } from "loopar";
import { bootTestTenant } from "../support/tenant.js";

/*
 * Loopar 7.6.0: CRM and Projects left the framework for the `erp` app
 * (AlfraERP). A tenant updated from before still has their records owned by
 * loopar; the framework update installs erp and erp reclaims them in place.
 */

let t;
const q = () => loopar.db.qx();

before(async () => { t = await bootTestTenant({ apps: ["erp"] }); });
after(async () => { await t?.teardown(); });

test("updating loopar on a pre-7.6 tenant installs erp and moves crm/projects to it, data kept", async () => {
  await t.run(async () => {
    const { createCustomer } = await import(path.join(process.cwd(), "apps", "erp", "modules", "crm", "customers.js"));
    const customer = await createCustomer({ customer_name: "Legacy Co", email: "legacy@co.test" });

    // Back to how a 7.5 tenant looks: no erp app, its records owned by loopar.
    await q()("App").where({ name: "erp" }).delete();
    await loopar.unsetApp("erp");
    await q()("Module").whereIn("name", ["crm", "projects"]).update({ app_name: "loopar" });
    await q()("Workflow").where({ name: "Project" }).update({ app: "loopar" });
    assert.equal(await loopar.appStatus("erp"), "uninstalled");

    const { default: Installer } = await import(path.join(process.cwd(), "apps", "loopar", "installer.js"));
    await new Installer({ app_name: "loopar" }).install(true);

    assert.equal(await loopar.appStatus("erp"), "installed");
    for (const module of ["crm", "projects", "billing"]) {
      assert.equal(await loopar.db.getValue("Module", "app_name", module), "erp", `Module ${module} belongs to erp`);
    }
    assert.equal((await q()("Workflow").where({ name: "Project" }).first())?.app, "erp");
    assert.equal(await loopar.db.getValue("Entity", "module", "Customer"), "crm");
    assert.equal(await loopar.db.getValue("Customer", "customer_name", customer), "Legacy Co", "customer rows kept");
    assert.ok(await portalProvider(), "erp provides the portal identity");
  });
});

test("a tenant without customers or projects does not get erp on update", async () => {
  await t.run(async () => {
    await q()("Customer Contact Link").delete();
    await q()("Customer Contact").delete();
    await q()("Customer").delete();
    await q()("Project").delete();
    await q()("App").where({ name: "erp" }).delete();
    await loopar.unsetApp("erp");

    const { default: Installer } = await import(path.join(process.cwd(), "apps", "loopar", "installer.js"));
    await new Installer({ app_name: "loopar" }).install(true);
    assert.equal(await loopar.appStatus("erp"), "uninstalled");
    assert.equal(await portalProvider(), null, "no provider: the portal scope reaches nothing");
  });
});

test("a stored grant with an unknown scope grants nothing (fails closed)", async () => {
  await t.run(async () => {
    const { PermissionManager } = await import("loopar");
    const user = await loopar.newDocument("User", { name: "scope@x.test", email: "scope@x.test", password: "Aa1!aaaaaaaa", confirm_password: "Aa1!aaaaaaaa", user_type: "Web", __document_status__: "Active" });
    await user.save({ validate: false });
    await loopar.db.insertRow("Permission", {
      name: "erp-split-unknown-scope", relation: "User", relation_name: "scope@x.test",
      document: "Signature Request", action: "list", scope: "customer", deny: 0, app: "loopar",
    });
    await PermissionManager.reload("scope@x.test");
    assert.equal(PermissionManager.scope("Signature Request", "list", "scope@x.test"), null);
  });
});
