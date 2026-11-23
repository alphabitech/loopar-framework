import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loopar, applyTransition } from "loopar";
import { bootTestTenant } from "../support/tenant.js";

/*
 * Staffing bills through the erp: the hours are erp hr timesheets, invoiced
 * by the erp. Staffing adds (apps/staffing/hr.js) the rates the client
 * agreed to, the rule that approved hours carry their rates, and the title
 * and generator of the client's invoice. Covers the 1.13.0 migration
 * (payment terms to the Customer, the removed Staffing Invoice).
 */

const root = process.cwd();
const staffing = (...p) => import(path.join(root, "apps", "staffing", ...p));
const erp = (...p) => import(path.join(root, "apps", "erp", "modules", ...p));
const q = () => loopar.db.qx();

let t, Installer, clients, Timesheet, hours;
let client, customer, place, site, worker;
const PERIOD = { from: "2026-11-02", to: "2026-11-08" };
const move = async (entity, name, action, values = {}) => applyTransition(await loopar.getDocument(entity, name), action, values, { system: true });
const keep = async (entity, data) => {
  const doc = await loopar.newDocument(entity, data);
  doc.__KEEP_NAME__ = true;
  await doc.save();
  return doc.name;
};
/** A staffing position: its erp Job Position and how the agency sells it. */
const position = async (name, pay, bill) => {
  await keep("Job Position", { name, default_pay_rate: pay, active: 1 });
  const doc = await loopar.newDocument("Staffing Position", { job_position: name, default_bill_rate: bill });
  await doc.save();
  return doc.name;
};
/** A completed 9 h shift (10 h less the unpaid hour) at the site. */
const worked = async (date, job_position = "Detailer") => {
  const doc = await loopar.newDocument("Shift", {
    job_position, location: place, shift_date: date, start_time: "08:00:00", end_time: "17:00:00", break_minutes: 60, headcount: 1,
    assignments: [{ employee: worker, check_in: `${date} 08:00:00`, check_out: `${date} 18:00:00` }],
  });
  await doc.save();
};
const sheetOf = (week) => q()("Timesheet").where({ employee: worker, week_start: week }).first();
const linesOf = async (sheet) => q()("Timesheet Line").where({ parent_document: "Timesheet", parent_id: sheet.id }).orderBy("work_date");

before(async () => {
  t = await bootTestTenant({ apps: ["erp"] });
  ({ default: Installer } = await staffing("installer.js"));
  await t.run(() => new Installer({ app_name: "staffing" }).install());
  clients = await staffing("modules", "staffing", "shared", "clients.js");
  ({ default: Timesheet } = await erp("hr", "entities", "timesheet", "timesheet.js"));
  hours = await erp("hr", "time-billing.js");

  await t.run(async () => {
    loopar.mail.send = async () => ({ ok: true });
    client = await clients.createClient({ customer: { customer_name: "Acme Rentals", email: "ap@acme.test" } });
    customer = await clients.clientCustomerName(client);
    place = await (await erp("crm", "addresses.js")).createAddress({ customer, title: "Airport Lot", city: "Atlanta" });
    const siteDoc = await loopar.newDocument("Staffing Site", { customer_address: place, client, status: "Active" });
    await siteDoc.save();
    site = siteDoc.name;

    assert.equal(await position("Detailer", 16, 28), "Detailer", "a staffing position is named as its Job Position");
    await position("Washer", 0, 0);
    await position("Driver", 20, 40);
    worker = await (await erp("hr", "employees.js")).createEmployee({
      full_name: "Ana Lopez", phone: "555-0100", status: "Active",
      positions: [{ job_position: "Detailer", pay_rate: 18 }, { job_position: "Washer" }, { job_position: "Driver" }],
    });

    // The client agreed to 30/h for detailers at this site, with its contract active since November.
    const agreement = await loopar.newDocument("Staffing Rate Agreement", { client, site, lines: [{ position: "Detailer", bill_rate: 30 }] });
    agreement.contractDefaults = { title: "Acme rates", valid_from: "2026-11-01" };
    await agreement.save();
    await move("Contract", (await q()("Staffing Rate Agreement").where({ name: agreement.name }).first()).contract, "Activate");
  });
});
after(async () => { await t?.teardown(); });

test("hours at a client's site take the agreed bill rate; the client's invoice is its own", async () => {
  await t.run(async () => {
    for (const day of ["02", "03", "04", "05", "06"]) await worked(`2026-11-${day}`);
    await Timesheet.generateWeek("2026-11-02");
    const sheet = await sheetOf("2026-11-02");
    const lines = await linesOf(sheet);
    assert.deepEqual([lines.length, Number(lines[0].bill_rate), Number(lines[0].pay_rate), lines[0].customer, lines[0].location], [5, 30, 18, customer, place]);
    assert.deepEqual([Number(sheet.total_hours), Number(sheet.overtime_hours), Number(sheet.billable_amount)], [45, 5, 1425]);

    await move("Timesheet", sheet.name, "Submit");
    await move("Timesheet", sheet.name, "Approve");
    const result = await hours.generateInvoices(PERIOD);
    assert.equal(result.created.length, 1);
    const invoice = await loopar.getDocument("Invoice", result.created[0]);
    assert.deepEqual([invoice.status, invoice.customer, invoice.title, invoice.generator_document, invoice.generator_name, Number(invoice.total)],
      ["Draft", customer, "Staffing services, 2026-11-02 to 2026-11-08", "Staffing Client", client, 1425]);
    const billed = await q()("Billing Line").where({ parent_document: "Invoice", parent_id: invoice.id }).orderBy("id");
    assert.deepEqual(billed.map((l) => [l.section, l.description, Number(l.quantity), l.unit, Number(l.rate)]), [
      ["Airport Lot", "Detailer — regular hours", 40, "Hour", 30],
      ["Airport Lot", "Detailer — overtime", 5, "Hour", 45],
    ]);
    assert.deepEqual((await hours.generateInvoices(PERIOD)).created, [], "billed once");
  });
});

test("without an agreed rate the position's default bill rate applies; outside the contract's validity too", async () => {
  await t.run(async () => {
    await worked("2026-11-09", "Driver");
    await worked("2026-10-26"); // before the contract started
    await Timesheet.generateWeek("2026-11-09");
    await Timesheet.generateWeek("2026-10-26");
    const [driver] = await linesOf(await sheetOf("2026-11-09"));
    assert.deepEqual([Number(driver.bill_rate), Number(driver.pay_rate)], [40, 20]);
    const [before] = await linesOf(await sheetOf("2026-10-26"));
    assert.deepEqual([Number(before.bill_rate), Number(before.pay_rate)], [28, 18]);
  });
});

test("hours for a client can't be approved without their pay and bill rate", async () => {
  await t.run(async () => {
    await worked("2026-11-16", "Washer");
    await Timesheet.generateWeek("2026-11-16");
    const sheet = await sheetOf("2026-11-16");
    await move("Timesheet", sheet.name, "Submit");
    await assert.rejects(move("Timesheet", sheet.name, "Approve"), /Missing pay or bill rate on 2026-11-16 \(Washer\)/);
    assert.equal((await q()("Timesheet").where({ name: sheet.name }).first()).status, "Submitted");
  });
});

test("the update moves a client's old payment terms to its Customer and removes the old invoice structure", async () => {
  await t.run(async () => {
    const q = () => loopar.db.qx();
    // What 1.12.x left: the terms on the client, and the empty invoice tables.
    await q().schema.alterTable("Staffing Client", (tb) => { tb.string("payment_terms"); });
    await q()("Staffing Client").where({ name: client }).update({ payment_terms: "Net 30" });
    await q().schema.createTable("Staffing Invoice", (tb) => { tb.increments("id"); tb.string("name"); });
    await q().schema.createTable("Staffing Invoice Line", (tb) => { tb.increments("id"); tb.string("name"); });
    await q()("Workflow").insert({ name: "Staffing Invoice", document: "Staffing Invoice", app: "staffing" }).catch(() => {});
  });

  await t.run(() => new Installer({ app_name: "staffing" }).install(true));

  await t.run(async () => {
    const q = () => loopar.db.qx();
    assert.equal(await loopar.db.getValue("Customer", "payment_terms", customer), "Net 30");
    assert.equal(await q().schema.hasColumn("Staffing Client", "payment_terms"), false);
    assert.equal(await q().schema.hasTable("Staffing Invoice"), false);
    assert.equal(await q().schema.hasTable("Staffing Invoice Line"), false);
    assert.equal(await loopar.db.count("Workflow", { name: "Staffing Invoice" }), 0);
    assert.equal(loopar.getRef("Staffing Invoice", false), null);
  });
});
