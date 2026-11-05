import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loopar, getCompany } from "loopar";
import { bootTestTenant } from "../support/tenant.js";

/** The gym's identity is the core Company; the update moves the old Gym Settings values there. */
let t;
let Installer;
let server;
const root = process.cwd();

before(async () => {
  t = await bootTestTenant();
  ({ default: Installer } = await import(path.join(root, "apps", "gym", "installer.js")));
  await t.run(() => new Installer({ app_name: "gym" }).install());
  server = await import(path.join(root, "apps", "gym", "modules", "gym", "shared", "server.js"));
});
after(async () => { await t?.teardown(); });

test("an update moves the gym's name, RTN and contact from Gym Settings to an empty Company", async () => {
  await t.run(async () => {
    const q = () => loopar.db.qx();
    const company = await loopar.getDocument("Company");
    Object.assign(company, { legal_name: "", tax_id: "", tax_id_label: "", phone: "", country: "" });
    await company.save();

    // A Gym Settings saved before gym 1.1.1 kept the identity as single values.
    for (const [field, value] of [["legal_name", "Iron Gym S. de R.L."], ["rtn", "08019000000001"], ["phone", "2230-0000"]]) {
      await q()("Document Single Values").insert({ name: `Gym Settings-${field}`, document: "Gym Settings", field, value });
    }
    await new Installer({ app_name: "gym" }).install(true);

    const c = await getCompany();
    assert.equal(c.legal_name, "Iron Gym S. de R.L.");
    assert.equal(c.tax_id, "08019000000001", "the leading zero survives");
    assert.equal(c.tax_id_label, "RTN");
    assert.equal(c.country, "HN");
    assert.equal(c.phone, "2230-0000");
    const left = await q()("Document Single Values").where({ document: "Gym Settings" }).whereIn("field", ["legal_name", "rtn", "phone"]);
    assert.equal(left.length, 0, "old values removed");
  });
});

test("gym settings expose the Company identity", async () => {
  await t.run(async () => {
    const s = await server.settings();
    const c = await getCompany();
    assert.equal(s.gym_name, c.company_name);
    assert.equal(s.rtn, "08019000000001");
    assert.equal(s.legal_name, "Iron Gym S. de R.L.");
  });
});
