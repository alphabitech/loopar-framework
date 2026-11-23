import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loopar, applyTransition, CHILD_POSITION_COLUMN } from "loopar";
import { bootTestTenant } from "../support/tenant.js";

/*
 * The sales pipeline is the erp Opportunity: a deal with a Customer or a
 * prospect, moved through its workflow; winning a prospect makes it a
 * Customer. A Staffing Opportunity details a deal (the staff a client asks
 * for), shares its code and reacts when it is won. Covers the 1.16.0
 * migration of the old staffing pipeline.
 */

const root = process.cwd();
const staffing = (...p) => import(path.join(root, "apps", "staffing", ...p));
const q = () => loopar.db.qx();
const move = async (name, action, values = {}) => applyTransition(await loopar.getDocument("Opportunity", name), action, values, { system: true });

let t, Installer, clients, client, customer;

before(async () => {
  t = await bootTestTenant({ apps: ["erp"] });
  ({ default: Installer } = await staffing("installer.js"));
  await t.run(() => new Installer({ app_name: "staffing" }).install());
  clients = await staffing("modules", "staffing", "shared", "clients.js");
  await t.run(async () => {
    loopar.mail.send = async () => ({ ok: true });
    client = await clients.createClient({ customer: { customer_name: "Acme Rentals", email: "ap@acme.test" }, client: { status: "Prospect" } });
    customer = await clients.clientCustomerName(client);
    const job = await loopar.newDocument("Job Position", { name: "Porter", active: 1, default_pay_rate: 15 });
    job.__KEEP_NAME__ = true;
    await job.save();
    await (await loopar.newDocument("Staffing Position", { job_position: "Porter", default_bill_rate: 25 })).save();
  });
});
after(async () => { await t?.teardown(); });

test("an erp opportunity is a deal with a customer or a prospect; winning a prospect makes it a customer", async () => {
  await t.run(async () => {
    await assert.rejects((await loopar.newDocument("Opportunity", { title: "Nobody" })).save(), /Choose the customer, or name the prospect/);
    const deal = await loopar.newDocument("Opportunity", { title: "Beta fleet wash", prospect_name: "Beta Fleet", contact_name: "Bo Beta", email: "Bo@beta.test", probability: 140, expected_value: 5000 });
    await deal.save();
    assert.match(deal.name, /^OPP-/);
    const row = await q()("Opportunity").where({ name: deal.name }).first();
    assert.deepEqual([row.stage, row.email, Number(row.probability)], ["New", "bo@beta.test", 100]);

    await assert.rejects(move(deal.name, "Mark lost"), /Lost reason is required/i);
    await move(deal.name, "Mark contacted");
    await move(deal.name, "Send proposal");
    await move(deal.name, "Mark won");
    const won = await q()("Opportunity").where({ name: deal.name }).first();
    const made = await q()("Customer").where({ name: won.customer }).first();
    assert.deepEqual([won.stage, made.customer_name, made.email], ["Won", "Beta Fleet", "bo@beta.test"]);
  });
});

test("a staffing opportunity opens its erp opportunity with the same code and feeds its value; winning activates the client and drafts the rates", async () => {
  await t.run(async () => {
    const doc = await loopar.newDocument("Staffing Opportunity", { client, expected_start: "2026-12-01", lines: [{ position: "Porter", headcount: 2, hours_per_week: 40 }] });
    doc.opportunityDefaults = { title: "Acme — porters", source: "Referral", notes: "Met at the expo." };
    await doc.save();

    const deal = await q()("Opportunity").where({ name: doc.name }).first();
    assert.equal(doc.opportunity, doc.name);
    assert.deepEqual([deal.title, deal.stage, deal.customer, deal.source, Number(deal.expected_value), deal.value_period, deal.generator_document, deal.generator_name, deal.notes],
      ["Acme — porters", "New", customer, "Referral", 2000, "Per week", "Staffing Opportunity", doc.name, "Met at the expo."]);
    assert.deepEqual(await (await loopar.newDocument("Staffing Opportunity")).titlesFor([doc.name]), { [doc.name]: "Acme — porters" });

    // The deal's value follows the requested staff while it is open.
    const stored = await loopar.getDocument("Staffing Opportunity", doc.name);
    stored.lines = [{ position: "Porter", headcount: 3, hours_per_week: 40, bill_rate: 30 }];
    await stored.save();
    assert.equal(Number((await q()("Opportunity").where({ name: doc.name }).first()).expected_value), 3600);
    assert.equal(Number((await q()("Opportunity").count({ c: "*" }).where({ generator_document: "Staffing Opportunity" }).first()).c), 1);

    await move(doc.name, "Qualify");
    await move(doc.name, "Send proposal");
    await move(doc.name, "Mark won");
    assert.equal(await loopar.db.getValue("Staffing Client", "status", client), "Active");
    const agreement = await q()("Staffing Rate Agreement").where({ opportunity: doc.name }).first();
    const contract = await q()("Contract").where({ name: agreement.contract }).first();
    assert.deepEqual([agreement.client, contract.status, contract.title, String(contract.valid_from).slice(0, 10)], [client, "Draft", "Acme Rentals rates", "2026-12-01"]);
    const { id } = agreement;
    const rate = await q()("Staffing Rate Line").where({ parent_document: "Staffing Rate Agreement", parent_id: id }).first();
    assert.deepEqual([rate.position, Number(rate.bill_rate)], ["Porter", 30]);
    await assert.rejects((await loopar.getDocument("Staffing Opportunity", doc.name)).delete(), /is Won/);
  });
});

test("a deal isn't won without its requested staff; deleting an open staffing opportunity takes its deal along", async () => {
  await t.run(async () => {
    const doc = await loopar.newDocument("Staffing Opportunity", { client });
    await doc.save();
    assert.equal((await q()("Opportunity").where({ name: doc.name }).first()).title, "Acme Rentals — staffing");
    await move(doc.name, "Mark contacted");
    await move(doc.name, "Send proposal");
    await assert.rejects(move(doc.name, "Mark won"), /Add the requested staff/);
    await (await loopar.getDocument("Staffing Opportunity", doc.name)).delete();
    assert.ok((await q()("Opportunity").where({ name: doc.name }).first()).__deleted_at__);
  });
});

test("a website inquiry becomes a staffing opportunity and its erp deal", async () => {
  await t.run(async () => {
    const inquiry = await loopar.newDocument("Staffing Inquiry", { company_name: "Gamma Parking", contact_name: "Gia Gamma", email: "gia@gamma.test", phone: "555-0133", message: "We need porters for our decks.", headcount: 4 });
    await inquiry.save();
    await applyTransition(await loopar.getDocument("Staffing Inquiry", inquiry.name), "Create opportunity", {}, { system: true });
    const converted = await q()("Staffing Inquiry").where({ name: inquiry.name }).first();
    const deal = await q()("Opportunity").where({ name: converted.opportunity }).first();
    const detail = await q()("Staffing Opportunity").where({ name: converted.opportunity }).first();
    assert.deepEqual([converted.stage, deal.title, deal.source, detail.inquiry, await clients.clientName(detail.client)], ["Converted", "Gamma Parking", "Website", inquiry.name, "Gamma Parking"]);
    assert.match(deal.notes, /Headcount: 4\n\nWe need porters for our decks\./);
  });
});

test("the update moves the old staffing pipeline to erp opportunities with the same codes", async () => {
  await t.run(async () => {
    await q().schema.alterTable("Staffing Opportunity", (tb) => {
      for (const c of ["title", "stage", "owner", "source", "next_step", "lost_reason"]) tb.string(c).nullable();
      tb.integer("probability").nullable(); tb.date("next_step_date").nullable(); tb.text("notes").nullable();
    });
    await q()("Staffing Opportunity").insert([
      { name: "OPP-90001", client, opportunity: "", estimated_weekly_hours: 80, estimated_weekly_value: 2400, title: "Acme decks", stage: "Site Visit", owner: "Administrator", source: "Cold Call", probability: 60, next_step: "Walk the site", next_step_date: "2026-12-03", notes: "Old notes" },
      { name: "OPP-90002", client, opportunity: "", estimated_weekly_value: 0, title: "Acme lost", stage: "Lost", lost_reason: "Price" },
    ]);
    const { id } = await q()("Staffing Opportunity").where({ name: "OPP-90001" }).first("id");
    await q()("Staffing Opportunity Line").insert({ name: "ol1", parent_id: id, parent_document: "Staffing Opportunity", [CHILD_POSITION_COLUMN]: 0, position: "Porter", headcount: 2, hours_per_week: 40, bill_rate: 30, weekly_value: 2400 });
    await q()("Workflow").insert({ name: "Staffing Opportunity", document: "Staffing Opportunity", state_field: "stage", app: "staffing", active: 1 });
  });

  await t.run(() => new Installer({ app_name: "staffing" }).install(true));
  await t.run(() => new Installer({ app_name: "staffing" }).install(true));

  await t.run(async () => {
    const deal = await q()("Opportunity").where({ name: "OPP-90001" }).first();
    assert.deepEqual([deal.title, deal.stage, deal.customer, deal.owner, deal.source, Number(deal.probability), deal.next_step, String(deal.next_step_date).slice(0, 10), deal.notes, Number(deal.expected_value), deal.value_period, deal.generator_name],
      ["Acme decks", "Qualified", customer, "Administrator", "Cold Call", 60, "Walk the site", "2026-12-03", "Old notes", 2400, "Per week", "OPP-90001"]);
    const lost = await q()("Opportunity").where({ name: "OPP-90002" }).first();
    assert.deepEqual([lost.stage, lost.lost_reason], ["Lost", "Price"]);
    assert.equal((await q()("Staffing Opportunity").where({ name: "OPP-90001" }).first()).opportunity, "OPP-90001");
    for (const c of ["title", "stage", "owner", "notes"]) assert.equal(await q().schema.hasColumn("Staffing Opportunity", c), false, `${c} dropped`);
    assert.equal((await q()("Workflow").select("name")).filter((w) => w.name === "Staffing Opportunity").length, 0);
    assert.equal(Number((await q()("Opportunity").whereIn("name", ["OPP-90001", "OPP-90002"]).count({ c: "*" }).first()).c), 2);

    // The migrated deal goes on: its staff is still there to win it.
    await move("OPP-90001", "Send proposal");
    await move("OPP-90001", "Mark won");
    assert.ok(await q()("Staffing Rate Agreement").where({ opportunity: "OPP-90001" }).first());
    // New deals number after the migrated ones.
    const next = await loopar.newDocument("Staffing Opportunity", { client });
    await next.save();
    assert.equal(next.name, "OPP-90003");
  });
});
