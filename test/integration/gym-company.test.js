import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loopar, getCompany } from "loopar";
import { bootTestTenant } from "../support/tenant.js";

/** The gym's identity is the core Company (name, legal name, tax id, currency). */
let t;
let server;
const root = process.cwd();

before(async () => {
  t = await bootTestTenant({ apps: ["erp", "gym"] });
  server = await import(path.join(root, "apps", "gym", "modules", "gym", "shared", "server.js"));
});
after(async () => { await t?.teardown(); });

test("gym settings expose the Company identity", async () => {
  await t.run(async () => {
    const company = await loopar.getDocument("Company");
    Object.assign(company, { company_name: "Iron Gym", legal_name: "Iron Gym LLC", tax_id: "0801900000001", currency: "USD" });
    await company.save();
    const s = await server.settings();
    const c = await getCompany();
    assert.equal(s.gym_name, c.company_name);
    assert.equal(s.tax_id, "0801900000001");
    assert.equal(s.legal_name, "Iron Gym LLC");
    assert.equal(s.currency, "USD");
  });
});
