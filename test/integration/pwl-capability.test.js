import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loopar } from "loopar";
import { bootTestTenant } from "../support/tenant.js";

/*
 * pwl capability statement: its wording lives in a Capability Statement
 * record (seeded by the installer, edited in the desk); the page reads it,
 * the published services and the Company record.
 */

const root = process.cwd();
const imp = (...p) => import(path.join(root, "apps", ...p));
let t, Controller;

before(async () => {
  t = await bootTestTenant({ apps: ["erp"] });
  for (const app of ["staffing", "pwl"]) {
    const { default: Installer } = await imp(app, "installer.js");
    await t.run(() => new Installer({ app_name: app }).install());
  }
  ({ default: Controller } = await imp("pwl", "modules", "pwl", "pages", "pwl-capability-statement", "pwl-capability-statement-controller.js"));
});
after(async () => { await t?.teardown(); });

const statement = () => t.run(async () => {
  const saved = loopar.webApp;
  loopar.webApp = { name: "pwl" };
  try {
    return await new Controller({}).publicActionStatement();
  } finally {
    loopar.webApp = saved;
  }
});

test("the installer seeds the approved statement as an editable record", async () => {
  await t.run(async () => {
    const doc = await loopar.getDocument("Capability Statement", "pwl-capability-statement");
    assert.equal(doc.app, "pwl");
    assert.match(doc.headline, /Real-Time Accountability/);
    const contacts = typeof doc.contacts === "string" ? JSON.parse(doc.contacts) : await doc.contacts;
    assert.deepEqual(contacts.map((c) => c.full_name), ["Mercedes Grullon Colon", "Haile M. Hernandez"]);
  });
});

test("the page shows the record, the services not linked to a model, and edits right away", async () => {
  let r = await statement();
  assert.ok(r.statement, "a statement");
  assert.equal(r.statement.models.length, 2);
  assert.deepEqual(r.statement.approach, ["Assess & Design", "Mobilize & Prepare", "Manage & Execute", "Measure & Improve"]);
  assert.equal(r.statement.contacts[0].email, "mgrullon@pwl.services");
  assert.ok(r.services.length >= 5);
  assert.ok(!r.services.some((s) => s.title === "Workforce Staffing Solutions"), "a model's service is not a capability");

  await t.run(() => loopar.db.setValue("Capability Statement", "headline", "Edited headline", "pwl-capability-statement"));
  r = await statement();
  assert.equal(r.statement.headline, "Edited headline");

  await t.run(() => loopar.db.setValue("Capability Statement", "published", 0, "pwl-capability-statement"));
  r = await statement();
  assert.equal(r.statement, null, "unpublished: nothing to show");
});
