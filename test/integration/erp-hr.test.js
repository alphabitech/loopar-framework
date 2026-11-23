import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loopar, applyTransition, requestContext } from "loopar";
import { bootTestTenant } from "../support/tenant.js";

/*
 * AlfraERP hr: employees and the positions they can work, their documents,
 * hiring (job openings, applicants → Employee), shifts with attendance, and
 * weekly timesheets whose hours are paid and, when worked for a customer at
 * a bill rate, invoiced once.
 */

let t, customer, place;
const root = process.cwd();
const erp = (...p) => import(path.join(root, "apps", "erp", "modules", ...p));
const q = () => loopar.db.qx();
/** Runs `fn` as that user, inside the tenant (a manager's moves check the user's roles). */
const as = (user, fn) => requestContext.run({ ...requestContext.getStore(), req: { __authUserName__: user, headers: {}, cookies: {} } }, fn);
const move = async (entity, name, action, values = {}) => applyTransition(await loopar.getDocument(entity, name), action, values, { system: true });

const keep = async (entity, data) => {
  const doc = await loopar.newDocument(entity, data);
  doc.__KEEP_NAME__ = true;
  await doc.save();
  return doc.name;
};
const employee = async (full_name, positions, extra = {}) => {
  const { createEmployee } = await erp("hr", "employees.js");
  return await createEmployee({ full_name, phone: "555-0100", status: "Active", positions, ...extra });
};
const shift = async (data) => {
  const doc = await loopar.newDocument("Shift", { job_position: "Porter", shift_date: "2026-11-02", start_time: "08:00:00", end_time: "17:00:00", break_minutes: 60, headcount: 1, ...data });
  await doc.save();
  return doc;
};

before(async () => {
  t = await bootTestTenant({ apps: ["erp"] });
  await t.run(async () => {
    loopar.mail.send = async () => ({ ok: true });
    const { createCustomer } = await erp("crm", "customers.js");
    const { createAddress } = await erp("crm", "addresses.js");
    customer = await createCustomer({ customer_name: "Acme Rentals", email: "ap@acme.test" });
    place = await createAddress({ customer, title: "Airport Lot", city: "Atlanta" });
    await keep("Job Position", { name: "Porter", default_pay_rate: 15, active: 1 });
    await keep("Job Position", { name: "Driver", default_pay_rate: 20, active: 1 });
  });
});
after(async () => { await t?.teardown(); });

test("an employee lists the positions it can work, once each; its documents follow their expiry", async () => {
  await t.run(async () => {
    const { employeePositions, isQualified, timeRates } = await erp("hr", "employees.js");
    await assert.rejects(employee("Twice", [{ job_position: "Porter" }, { job_position: "Porter" }]), /appears twice/);

    const ana = await employee("  Ana   Lopez ", [{ job_position: "Porter", pay_rate: 18 }, { job_position: "Driver" }], { email: "ANA@x.test" });
    assert.match(ana, /^EMP-/);
    const row = await q()("Employee").where({ name: ana }).first();
    assert.deepEqual([row.full_name, row.email], ["Ana Lopez", "ana@x.test"]);
    assert.deepEqual((await employeePositions(ana)).map((p) => p.job_position), ["Porter", "Driver"]);
    assert.equal(await isQualified(ana, "Driver"), true);

    // Pay: the employee's own rate for the position, else the position's; no bill rate without an app.
    assert.deepEqual(await timeRates({ employee: ana, job_position: "Porter", date: "2026-11-02" }), { pay_rate: 18, bill_rate: 0, overtime_multiplier: 1.5 });
    assert.equal((await timeRates({ employee: ana, job_position: "Driver", date: "2026-11-02" })).pay_rate, 20);

    await keep("Employee Document Type", { name: "Driver License", active: 1 });
    const iso = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
    const status = async (data) => {
      const doc = await loopar.newDocument("Employee Document", { employee: ana, document_type: "Driver License", ...data });
      await doc.save();
      return [doc.status, doc.number_last4 || null];
    };
    assert.deepEqual(await status({}), ["Pending", null]);
    assert.deepEqual(await status({ expires_on: iso(400), number_last4: "D123-456-7890" }), ["Valid", "7890"]);
    assert.deepEqual(await status({ expires_on: iso(10) }), ["Expiring Soon", null]);
    assert.deepEqual(await status({ expires_on: iso(-1) }), ["Expired", null]);
  });
});

test("only open job openings are published; an applicant moves through the pipeline and Hire makes the Employee", async () => {
  await t.run(async () => {
    const opening = await loopar.newDocument("Job Opening", { title: "Porter — ATL", job_position: "Porter", status: "Draft", published: 1, location: "Atlanta, GA" });
    await opening.save();
    assert.equal(Number((await q()("Job Opening").where({ name: opening.name }).first()).published), 0);
    const stored = await loopar.getDocument("Job Opening", opening.name);
    Object.assign(stored, { status: "Open", published: 1 });
    await stored.save();

    const applicant = await loopar.newDocument("Job Applicant", { full_name: "Ben Ruiz", email: "Ben@x.test", phone: "555-0111", job_opening: opening.name });
    await applicant.save();
    assert.deepEqual([applicant.stage, applicant.job_position, applicant.email], ["New", "Porter", "ben@x.test"]);

    await move("Job Applicant", applicant.name, "Start screening");
    await assert.rejects(move("Job Applicant", applicant.name, "Schedule interview"), /Interview at is required/i);
    await move("Job Applicant", applicant.name, "Schedule interview", { interview_at: "2026-11-05 10:00:00" });
    await move("Job Applicant", applicant.name, "Run background check");
    await move("Job Applicant", applicant.name, "Make offer");
    const result = await move("Job Applicant", applicant.name, "Hire");

    const hired = await q()("Job Applicant").where({ name: applicant.name }).first();
    assert.equal(hired.stage, "Hired");
    assert.match(result.navigate, /\/desk\/Employee\/update/);
    const made = await q()("Employee").where({ name: hired.employee }).first();
    assert.deepEqual([made.full_name, made.status, made.job_applicant, made.phone], ["Ben Ruiz", "Onboarding", applicant.name, "555-0111"]);
    const { isQualified } = await erp("hr", "employees.js");
    assert.equal(await isQualified(hired.employee, "Porter"), true);
  });
});

test("a shift seats working, qualified, free employees; clock times become paid hours and its status", async () => {
  await t.run(async () => {
    const ana = (await q()("Employee").where({ full_name: "Ana Lopez" }).first()).name;
    const onlyDriver = await employee("Dan Only Driver", [{ job_position: "Driver" }]);
    const gone = await employee("Gus Gone", [{ job_position: "Porter" }], { status: "Terminated" });

    await assert.rejects(shift({ assignments: [{ employee: onlyDriver }] }), /not qualified as Porter/);
    await assert.rejects(shift({ assignments: [{ employee: gone }] }), /is Terminated/);
    await assert.rejects(shift({ assignments: [{ employee: ana }, { employee: (await q()("Employee").where({ full_name: "Ben Ruiz" }).first()).name }] }), /needs 1 employee/);

    const doc = await shift({ location: place, headcount: 2, assignments: [{ employee: ana }] });
    assert.deepEqual([doc.status, doc.customer, Number(doc.scheduled_hours), Number(doc.assigned_count)], ["Partially Filled", customer, 8, 1]);
    await assert.rejects(shift({ start_time: "16:00:00", end_time: "20:00:00", assignments: [{ employee: ana }] }), /already works another shift/);

    const stored = await loopar.getDocument("Shift", doc.name);
    stored.headcount = 1;
    stored.assignments = [{ employee: ana, check_in: "2026-11-02 08:00:00", check_out: "2026-11-02 18:00:00" }];
    await stored.save();
    const seat = await q()("Shift Assignment").where({ parent_document: "Shift", parent_id: stored.id }).first();
    assert.deepEqual([stored.status, seat.status, Number(seat.hours)], ["Completed", "Completed", 9], "10 h less the unpaid hour");
  });
});

test("the week's completed shifts become a timesheet: overtime, frozen once submitted, exported to payroll", async () => {
  await t.run(async () => {
    const { default: Timesheet } = await erp("hr", "entities", "timesheet", "timesheet.js");
    const ana = (await q()("Employee").where({ full_name: "Ana Lopez" }).first()).name;
    // Monday 2026-11-02 already has 9 h; four more days of 9 h make 45.
    for (const day of ["03", "04", "05", "06"]) {
      await shift({ location: place, shift_date: `2026-11-${day}`, assignments: [{ employee: ana, check_in: `2026-11-${day} 08:00:00`, check_out: `2026-11-${day} 18:00:00` }] });
    }

    const made = await Timesheet.generateWeek("2026-11-04");
    assert.deepEqual([made.week, made.created], ["2026-11-02", 1]);
    const sheet = await q()("Timesheet").where({ employee: ana }).first();
    assert.deepEqual([Number(sheet.total_hours), Number(sheet.regular_hours), Number(sheet.overtime_hours), Number(sheet.gross_pay), Number(sheet.billable_amount)],
      [45, 40, 5, 45 * 18 + 5 * 18 * 0.5, 0]);
    const lines = await q()("Timesheet Line").where({ parent_document: "Timesheet", parent_id: sheet.id }).orderBy("work_date");
    assert.deepEqual([lines.length, lines[0].customer, lines[0].location, lines[0].job_position, Number(lines[0].pay_rate)], [5, customer, place, "Porter", 18]);

    const twin = await loopar.newDocument("Timesheet", { employee: ana, week_start: "2026-11-06" });
    await assert.rejects(twin.save(), /already has a timesheet for the week of 2026-11-02/);

    await move("Timesheet", sheet.name, "Submit");
    // Frozen: a rate changed afterwards does not reach the submitted hours.
    await q()("Employee Position").where({ job_position: "Porter", pay_rate: 18 }).update({ pay_rate: 99 });
    await (await loopar.getDocument("Timesheet", sheet.name)).save();
    assert.equal(Number((await q()("Timesheet").where({ name: sheet.name }).first()).gross_pay), 855);
    assert.equal((await Timesheet.generateWeek("2026-11-02")).skipped, 1);

    await assert.rejects(Timesheet.exportPayroll("2026-11-02"), /no Approved timesheets/);
    await move("Timesheet", sheet.name, "Approve");
    // Exporting marks each timesheet Exported: a manager's move.
    await assert.rejects(Timesheet.exportPayroll("2026-11-02"), /"Mark exported" is not available/);
    const out = await as("Administrator", () => Timesheet.exportPayroll("2026-11-02"));
    assert.equal(out.count, 1);
    assert.match(out.csv.split("\n")[1], new RegExp(`^,${ana},Ana Lopez,2026-11-02,40,5,18,720,135,855,${sheet.name}$`));
    const exported = await q()("Timesheet").where({ name: sheet.name }).first();
    assert.deepEqual([exported.status, exported.payroll_batch], ["Exported", out.batch]);
  });
});

test("approved hours with a customer and a bill rate are invoiced once; cancelling or deleting the invoice frees them", async () => {
  await t.run(async () => {
    const { generateInvoices } = await erp("hr", "time-billing.js");
    const PERIOD = { from: "2026-11-02", to: "2026-11-08" };
    assert.deepEqual((await generateInvoices(PERIOD)).created, [], "no bill rate, nothing to charge");

    const sheet = await q()("Timesheet").first();
    await q()("Timesheet Line").where({ parent_document: "Timesheet", parent_id: sheet.id }).update({ bill_rate: 30 });
    await keep("Item", { name: "SRV-PORTER", item_name: "Porter labor", item_type: "Service", rate: 99 });
    await q()("Job Position").where({ name: "Porter" }).update({ item: "SRV-PORTER" });

    const { created: [name], lines } = await generateInvoices(PERIOD);
    assert.equal(lines, 5);
    const invoice = await loopar.getDocument("Invoice", name);
    assert.deepEqual([invoice.status, invoice.customer, String(invoice.period_start).slice(0, 10), Number(invoice.total)], ["Draft", customer, "2026-11-02", 40 * 30 + 5 * 45]);
    const billed = await q()("Billing Line").where({ parent_document: "Invoice", parent_id: invoice.id }).orderBy("id");
    assert.deepEqual(billed.map((l) => [l.section, l.item, l.description, Number(l.quantity), Number(l.rate)]), [
      ["Airport Lot", "SRV-PORTER", "Porter — regular hours", 40, 30],
      ["Airport Lot", "SRV-PORTER", "Porter — overtime", 5, 45],
    ]);
    assert.deepEqual((await generateInvoices(PERIOD)).created, [], "billed once");

    await invoice.delete();
    const { created: [second] } = await generateInvoices({ ...PERIOD, customer });
    assert.ok(second && second !== name, "freed by deleting the draft");
    const issued = await loopar.getDocument("Invoice", second);
    await issued.issue();
    await (await loopar.getDocument("Invoice", second)).cancel({ reason: "Wrong period" });
    const stamps = await q()("Timesheet Line").where({ parent_document: "Timesheet", parent_id: sheet.id }).distinct("invoice");
    assert.deepEqual(stamps.map((s) => s.invoice || null), [null], "freed by cancelling the issued invoice");
  });
});

test("the phone clock ships with hr: its page, the employee's link token and the settings it reads", async () => {
  await t.run(async () => {
    const ref = loopar.getRef("Employee Clock");
    assert.deepEqual([ref?.__ENTITY__, ref?.__APP__], ["Page Builder", "erp"]);
    const attendance = await erp("hr", "attendance.js");
    const name = await employee("Clock Tester", [{ job_position: "Porter" }]);
    const token = "c".repeat(32);
    await q()("Employee").where({ name }).update({ clock_token_hash: attendance.clockTokenHash(token) });
    assert.equal((await attendance.employeeByClockToken(token)).name, name);
    // Not working any more: the link stops answering.
    await q()("Employee").where({ name }).update({ status: "Terminated" });
    assert.equal(await attendance.employeeByClockToken(token), null);
    for (const field of ["clock_in_early_minutes", "clock_gps_slack_m", "clock_require_location"]) {
      assert.ok(loopar.getRef("HR Settings").__FIELDS__.includes(field), field);
    }
  });
});
