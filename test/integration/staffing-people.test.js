import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loopar, applyTransition, CHILD_POSITION_COLUMN } from "loopar";
import { bootTestTenant } from "../support/tenant.js";

/*
 * Staffing on the erp hr module: a Staffing Worker is an Employee (same
 * code) with the agency's data; a website application opens a Job
 * Applicant and hiring makes the worker; the phone clock and the stations
 * work on erp Shifts. Covers the 1.15.0 migration (positions, settings,
 * workers, documents, openings, applicants, shifts and timesheets move to
 * the erp).
 */

const root = process.cwd();
const staffing = (...p) => import(path.join(root, "apps", "staffing", ...p));
const erp = (...p) => import(path.join(root, "apps", "erp", "modules", ...p));
const q = () => loopar.db.qx();
const move = async (entity, name, action, values = {}) => applyTransition(await loopar.getDocument(entity, name), action, values, { system: true });
const keep = async (entity, data) => {
  const doc = await loopar.newDocument(entity, data);
  doc.__KEEP_NAME__ = true;
  await doc.save();
  return doc.name;
};
const pad = (n) => String(n).padStart(2, "0");
const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localTime = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}:00`;

let t, Installer, clients, workers, attendance;
let client, customer, place, site;

before(async () => {
  t = await bootTestTenant({ apps: ["erp"] });
  ({ default: Installer } = await staffing("installer.js"));
  await t.run(() => new Installer({ app_name: "staffing" }).install());
  clients = await staffing("modules", "staffing", "shared", "clients.js");
  workers = await staffing("modules", "staffing", "shared", "workers.js");
  attendance = await erp("hr", "attendance.js");

  await t.run(async () => {
    loopar.mail.send = async () => ({ ok: true });
    client = await clients.createClient({ customer: { customer_name: "Acme Rentals", email: "ap@acme.test" } });
    customer = await clients.clientCustomerName(client);
    place = await (await erp("crm", "addresses.js")).createAddress({ customer, title: "ATL Rental Car Center", city: "Atlanta", latitude: 33.6407, longitude: -84.4277, geofence_radius_m: 100 });
    const doc = await loopar.newDocument("Staffing Site", { customer_address: place, client, status: "Active" });
    await doc.save();
    site = doc.name;
    await keep("Job Position", { name: "Porter", default_pay_rate: 15, active: 1 });
    await (await loopar.newDocument("Staffing Position", { job_position: "Porter", default_bill_rate: 25 })).save();
  });
});
after(async () => { await t?.teardown(); });

test("a worker is its employee: same code, the employee's name as title, its own badge", async () => {
  await t.run(async () => {
    const employee = await (await erp("hr", "employees.js")).createEmployee({ full_name: "Ana Lopez", preferred_name: "Anita", phone: "555-0100", email: "ana@x.test", status: "Active", positions: [{ job_position: "Porter" }] });
    const name = await workers.ensureWorker(employee, { languages: "Spanish", home_site: site });
    assert.equal(name, employee);
    assert.equal(await workers.ensureWorker(employee), employee, "once");

    const row = await q()("Staffing Worker").where({ name }).first();
    assert.deepEqual([row.employee, row.languages, row.home_site], [employee, "Spanish", site]);
    assert.match(row.badge_code, /^W[2-9A-HJ-NP-Z]{7}$/);

    const doc = await loopar.newDocument("Staffing Worker");
    assert.deepEqual(await doc.titlesFor([name]), { [name]: "Anita" });
    assert.deepEqual((await doc.getListToSelectElement("lopez")).rows.map((r) => [r.name, r.full_name]), [[name, "Anita"]]);
    await assert.rejects((await loopar.newDocument("Staffing Worker", { employee })).save(), /already is a worker/);

    const who = await workers.workerWithEmployee(name);
    assert.deepEqual([who.display_name, who.email, who.working, who.badge_code], ["Anita", "ana@x.test", true, row.badge_code]);

    await assert.rejects((await loopar.newDocument("Staffing Position", { job_position: "Porter" })).save(), /already is a staffing position/);
  });
});

test("a website application opens a Job Applicant; no offer before the background check; hiring makes the worker", async () => {
  await t.run(async () => {
    const form = await loopar.newDocument("Staffing Applicant", {
      full_name: "Ben Ruiz", email: "ben@x.test", phone: "555-0111", city_state: "Atlanta, GA", availability: "Nights",
      areas_of_interest: "Customer Service,Not An Option", experience: "Two years at a rental counter.",
      applying_for: "Porter", languages: "Both",
    });
    await form.save();
    const stored = await q()("Staffing Applicant").where({ name: form.name }).first();
    assert.equal(stored.areas_of_interest, "Customer Service", "only the offered areas are kept");
    const applicant = await q()("Job Applicant").where({ name: stored.job_applicant }).first();
    assert.deepEqual([applicant.full_name, applicant.stage, applicant.source, applicant.location, applicant.generator_document, applicant.generator_name],
      ["Ben Ruiz", "New", "Website", "Atlanta, GA", "Staffing Applicant", form.name]);
    assert.match(applicant.notes, /Requested role: Porter\nAreas of interest: Customer Service/);

    const spam = await loopar.newDocument("Staffing Applicant", { full_name: "Spam Bot", email: "s@spam.test", status: "Spam" });
    await spam.save();
    assert.equal((await q()("Staffing Applicant").where({ name: spam.name }).first()).job_applicant || null, null, "spam opens nothing");

    await q()("Job Applicant").where({ name: applicant.name }).update({ job_position: "Porter" });
    await move("Job Applicant", applicant.name, "Start screening");
    await move("Job Applicant", applicant.name, "Schedule interview", { interview_at: "2026-11-05 10:00:00" });
    await move("Job Applicant", applicant.name, "Run background check");
    await assert.rejects(move("Job Applicant", applicant.name, "Make offer"), /background check must be Clear/);
    await q()("Staffing Applicant").where({ name: form.name }).update({ background_check_status: "Clear" });
    await move("Job Applicant", applicant.name, "Make offer");
    await move("Job Applicant", applicant.name, "Hire");

    const hired = await q()("Job Applicant").where({ name: applicant.name }).first();
    const worker = await q()("Staffing Worker").where({ name: hired.employee }).first();
    assert.deepEqual([hired.stage, worker.employee, worker.applicant, worker.languages, worker.background_check_status],
      ["Hired", hired.employee, form.name, "Both", "Clear"]);
    assert.equal((await q()("Employee").where({ name: hired.employee }).first()).full_name, "Ben Ruiz");
  });
});

test("the erp phone clock works for a worker: the employee's token, the location's geofence, the station's badge", async () => {
  await t.run(async () => {
    const stations = await staffing("modules", "staffing", "shared", "stations.js");
    const name = (await q()("Employee").where({ full_name: "Ana Lopez" }).first()).name;
    const token = "t".repeat(32);
    await q()("Employee").where({ name }).update({ clock_token_hash: attendance.clockTokenHash(token) });
    const worker = await attendance.employeeByClockToken(token);
    assert.deepEqual([worker.name, worker.display_name], [name, "Anita"]);
    assert.equal(await attendance.employeeByClockToken("x".repeat(32)), null);

    // A shift that started an hour ago, at the site's location.
    const start = new Date(Date.now() - 3600000), end = new Date(Date.now() + 3 * 3600000);
    const shift = await loopar.newDocument("Shift", {
      job_position: "Porter", location: place, shift_date: localDate(start), start_time: localTime(start), end_time: localTime(end),
      break_minutes: 0, headcount: 1, assignments: [{ employee: name }],
    });
    await shift.save();

    const [mine] = await attendance.employeeShifts(worker);
    assert.deepEqual([mine.shift, mine.site, mine.position, mine.geofenced, mine.can_clock_in], [shift.name, "ATL Rental Car Center", "Porter", true, true]);
    assert.equal((await stations.identifyWorker({ site, require_clock_in: 0 }, (await q()("Staffing Worker").where({ name }).first()).badge_code)).shift, null);
    await assert.rejects(stations.identifyWorker({ site, require_clock_in: 1 }, (await q()("Staffing Worker").where({ name }).first()).badge_code), /Anita: clock in to your shift/);

    await assert.rejects(attendance.clock(worker, shift.name, "in", { lat: 33.7, lng: -84.4277 }), /from the site/);
    const { distance } = await attendance.clock(worker, shift.name, "in", { lat: 33.6408, lng: -84.4277 });
    assert.ok(distance < 150);
    const { id: shiftId } = await q()("Shift").where({ name: shift.name }).first("id");
    const seat = await q()("Shift Assignment").where({ parent_document: "Shift", parent_id: shiftId }).first();
    assert.deepEqual([seat.status, Number(seat.check_in_distance_m)], ["Checked In", distance]);
    const badge = (await q()("Staffing Worker").where({ name }).first()).badge_code;
    assert.deepEqual(await stations.identifyWorker({ site, require_clock_in: 1 }, badge), { worker: name, full_name: "Anita", shift: shift.name });

    await attendance.clock(worker, shift.name, "out", { lat: 33.6408, lng: -84.4277 });
    assert.equal((await q()("Shift").where({ name: shift.name }).first()).status, "Completed");
  });
});

test("the update moves positions, settings, workers, documents, openings, applicants, shifts and timesheets to the erp", async () => {
  await t.run(async () => {
    const child = (tb) => { tb.increments("id"); tb.string("name"); tb.integer("parent_id"); tb.string("parent_document"); tb.integer(CHILD_POSITION_COLUMN).nullable(); };
    // What 1.14.x left: old columns and the tables of the entities that moved.
    await q().schema.alterTable("Staffing Position", (tb) => { tb.string("category").nullable(); tb.integer("active").nullable(); tb.decimal("default_pay_rate", 12, 2).nullable(); tb.text("description").nullable(); tb.string("item").nullable(); });
    await q().schema.alterTable("Staffing Worker", (tb) => {
      for (const c of ["full_name", "preferred_name", "status", "phone", "email", "address", "city", "state", "zip_code", "employment_type", "payroll_id", "user", "emergency_contact_name", "emergency_contact_phone"]) tb.string(c).nullable();
      tb.date("hire_date").nullable(); tb.date("termination_date").nullable();
    });
    await q().schema.createTable("Staffing Worker Position", (tb) => { child(tb); tb.string("position"); tb.decimal("pay_rate", 12, 2).nullable(); tb.date("qualified_on").nullable(); });
    await q().schema.createTable("Staffing Worker Document", (tb) => {
      tb.increments("id"); tb.string("name"); tb.string("worker"); tb.string("document_type"); tb.string("status"); tb.string("number_last4").nullable();
      tb.date("issued_on").nullable(); tb.date("expires_on").nullable(); tb.string("attachment").nullable(); tb.text("notes").nullable();
    });
    await q().schema.createTable("Staffing Job Opening", (tb) => {
      tb.increments("id");
      for (const c of ["name", "title", "status", "position", "site", "employment_type", "shifts", "location", "summary"]) tb.string(c).nullable();
      tb.integer("published").nullable(); tb.integer("openings").nullable(); tb.decimal("pay_min", 12, 2).nullable(); tb.decimal("pay_max", 12, 2).nullable();
      tb.text("description").nullable(); tb.text("requirements").nullable();
    });
    await q().schema.alterTable("Staffing Applicant", (tb) => {
      for (const c of ["stage", "source", "job_opening", "position", "interviewer", "rejection_reason", "worker"]) tb.string(c).nullable();
      tb.datetime("interview_at").nullable(); tb.text("recruiter_notes").nullable();
    });
    await q().schema.createTable("Staffing Shift", (tb) => {
      tb.increments("id");
      for (const c of ["name", "site", "position", "status", "start_time", "end_time", "client", "notes"]) tb.string(c).nullable();
      tb.date("shift_date"); tb.integer("break_minutes").nullable(); tb.integer("headcount").nullable(); tb.integer("assigned_count").nullable(); tb.decimal("scheduled_hours", 12, 2).nullable();
    });
    await q().schema.createTable("Staffing Shift Assignment", (tb) => {
      child(tb); tb.string("worker"); tb.string("status"); tb.datetime("check_in").nullable(); tb.datetime("check_out").nullable();
      tb.decimal("hours", 12, 2).nullable(); tb.decimal("check_in_distance_m", 12, 2).nullable(); tb.decimal("check_out_distance_m", 12, 2).nullable();
    });
    await q().schema.createTable("Staffing Timesheet", (tb) => {
      tb.increments("id");
      for (const c of ["name", "worker", "status", "review_notes", "payroll_batch"]) tb.string(c).nullable();
      tb.date("week_start");
      for (const c of ["total_hours", "regular_hours", "overtime_hours", "gross_pay", "billable_amount"]) tb.decimal(c, 12, 2).nullable();
    });
    await q().schema.createTable("Staffing Timesheet Line", (tb) => {
      child(tb); tb.date("work_date");
      for (const c of ["shift", "site", "position", "invoice"]) tb.string(c).nullable();
      for (const c of ["hours", "pay_rate", "bill_rate", "overtime_multiplier"]) tb.decimal(c, 12, 2).nullable();
    });

    await q()("Staffing Position").insert({ name: "Shuttle Driver", job_position: "", default_bill_rate: 35, license_required: "CDL", category: "Driving", active: 1, default_pay_rate: 19, description: "Drives the shuttle." });
    for (const [field, value] of Object.entries({ overtime_threshold_hours: "44", document_alert_days: "45", recruiting_notify_email: "hr@pwl.test", operations_notify_email: "ops@pwl.test" })) {
      await q()("Document Single Values").insert({ name: `Staffing Settings-${field}`, document: "Staffing Settings", field, value });
    }

    await q()("Staffing Worker").insert({
      name: "WRK-90001", employee: "", badge_code: "WOLD0001", languages: "Spanish", i9_status: "Clear", home_site: site,
      full_name: "  Old   Worker ", preferred_name: "Oldie", status: "Active", phone: "555-0190", email: "Old@x.test", city: "Atlanta", state: "GA",
      hire_date: "2026-03-01", employment_type: "Part-time", payroll_id: "P-1", emergency_contact_name: "Mom", emergency_contact_phone: "555-0000",
    });
    const { id: workerId } = await q()("Staffing Worker").where({ name: "WRK-90001" }).first("id");
    await q()("Staffing Worker Position").insert([
      { name: "wp1", parent_id: workerId, parent_document: "Staffing Worker", [CHILD_POSITION_COLUMN]: 0, position: "Shuttle Driver", pay_rate: 21, qualified_on: "2026-03-02" },
      { name: "wp2", parent_id: workerId, parent_document: "Staffing Worker", [CHILD_POSITION_COLUMN]: 1, position: "Porter", pay_rate: null },
    ]);
    await q()("Staffing Worker Document").insert({ name: "WDOC-90001", worker: "WRK-90001", document_type: "CDL", status: "Valid", number_last4: "1234", issued_on: "2025-01-01", expires_on: "2030-01-01", notes: "Class B" });
    await q()("Staffing Job Opening").insert({ name: "JOB-9001", title: "Shuttle Driver — ATL", status: "Open", published: 1, position: "Shuttle Driver", site, openings: 2, employment_type: "Full-time", shifts: "Nights", pay_min: 19, pay_max: 22, location: "", summary: "CDL required" });

    for (const row of [
      { name: "APL-90001", full_name: "Old Worker", email: "old@x.test", status: "Read", stage: "Hired", source: "Referral", job_opening: "JOB-9001", position: "Shuttle Driver", worker: "WRK-90001", interview_at: "2026-02-20 09:00:00", recruiter_notes: "Great attitude", applying_for: "Driver" },
      { name: "APL-90002", full_name: "No License", email: "nl@x.test", status: "Read", stage: "Rejected", rejection_reason: "No License", position: "Shuttle Driver" },
      { name: "APL-90003", full_name: "Spammer", email: "sp@x.test", status: "Spam", stage: "New" },
    ]) await q()("Staffing Applicant").insert({ job_applicant: "", ...row });

    await q()("Staffing Shift").insert({ name: "SHF-90001", site, position: "Shuttle Driver", status: "Completed", shift_date: "2026-10-05", start_time: "08:00:00", end_time: "16:00:00", break_minutes: 30, headcount: 1, assigned_count: 1, scheduled_hours: 7.5, client, notes: "Old shift" });
    const { id: shiftId } = await q()("Staffing Shift").where({ name: "SHF-90001" }).first("id");
    await q()("Staffing Shift Assignment").insert({ name: "sa1", parent_id: shiftId, parent_document: "Staffing Shift", [CHILD_POSITION_COLUMN]: 0, worker: "WRK-90001", status: "Completed", check_in: "2026-10-05 08:00:00", check_out: "2026-10-05 16:00:00", hours: 7.5, check_in_distance_m: 12 });
    await q()("Staffing Timesheet").insert({ name: "TS-90001", worker: "WRK-90001", week_start: "2026-10-05", status: "Exported", total_hours: 7.5, regular_hours: 7.5, overtime_hours: 0, gross_pay: 157.5, billable_amount: 262.5, payroll_batch: "PAY-OLD" });
    const { id: sheetId } = await q()("Staffing Timesheet").where({ name: "TS-90001" }).first("id");
    await q()("Staffing Timesheet Line").insert({ name: "tl1", parent_id: sheetId, parent_document: "Staffing Timesheet", [CHILD_POSITION_COLUMN]: 0, work_date: "2026-10-05", shift: "SHF-90001", site, position: "Shuttle Driver", hours: 7.5, pay_rate: 21, bill_rate: 35, overtime_multiplier: 1.5, invoice: "INV-OLD" });

    for (const name of ["Staffing Applicant", "Staffing Timesheet"]) await q()("Workflow").insert({ name, document: name, state_field: "status", app: "staffing", active: 1 });
    await q()("Permission").insert({ name: "Role-Staffing Supervisor-Old Shift", relation: "Role", relation_name: "Staffing Supervisor", document: "Staffing Shift", action: "view", deny: 0, app: "staffing" });
  });

  await t.run(() => new Installer({ app_name: "staffing" }).install(true));

  await t.run(async () => {
    const has = (table, column) => (column ? q().schema.hasColumn(table, column) : q().schema.hasTable(table));
    const eav = async (document) => Object.fromEntries((await q()("Document Single Values").where({ document }).select("field", "value")).map((r) => [r.field, r.value]));

    // Position: the Job Position holds the job, the staffing position how it is sold.
    const job = await q()("Job Position").where({ name: "Shuttle Driver" }).first();
    assert.deepEqual([job.category, Number(job.active), Number(job.default_pay_rate), job.description], ["Driving", 1, 19, "Drives the shuttle."]);
    const sold = await q()("Staffing Position").where({ name: "Shuttle Driver" }).first();
    assert.deepEqual([sold.job_position, Number(sold.default_bill_rate), sold.license_required], ["Shuttle Driver", 35, "CDL"]);
    for (const c of ["category", "active", "default_pay_rate", "description", "item"]) assert.equal(await has("Staffing Position", c), false, `${c} dropped`);

    // Settings.
    const hr = await eav("HR Settings");
    assert.deepEqual([hr.overtime_threshold_hours, hr.document_alert_days, hr.recruiting_notify_email, hr.scheduling_notify_email], ["44", "45", "hr@pwl.test", "ops@pwl.test"]);
    assert.deepEqual(Object.keys(await eav("Staffing Settings")).filter((f) => /overtime|document_alert|recruiting|operations/.test(f)), []);

    // Worker → Employee with the same code, its positions and pay rates.
    const employee = await q()("Employee").where({ name: "WRK-90001" }).first();
    assert.deepEqual([employee.full_name, employee.preferred_name, employee.status, employee.phone, employee.email, employee.employment_type, employee.payroll_id, String(employee.hire_date).slice(0, 10), employee.emergency_contact_name],
      ["Old Worker", "Oldie", "Active", "555-0190", "old@x.test", "Part-time", "P-1", "2026-03-01", "Mom"]);
    const positions = await q()("Employee Position").where({ parent_document: "Employee", parent_id: employee.id }).orderBy(CHILD_POSITION_COLUMN);
    assert.deepEqual(positions.map((p) => [p.job_position, p.pay_rate === null ? null : Number(p.pay_rate)]), [["Shuttle Driver", 21], ["Porter", null]]);
    const worker = await q()("Staffing Worker").where({ name: "WRK-90001" }).first();
    assert.deepEqual([worker.employee, worker.badge_code, worker.languages, worker.i9_status, worker.home_site], ["WRK-90001", "WOLD0001", "Spanish", "Clear", site]);
    for (const c of ["full_name", "phone", "status", "payroll_id"]) assert.equal(await has("Staffing Worker", c), false, `${c} dropped`);
    assert.equal(await has("Staffing Worker Position"), false);

    // Document → Employee Document, its type in the catalog.
    const document = await q()("Employee Document").where({ employee: "WRK-90001" }).first();
    assert.deepEqual([document.document_type, document.status, document.number_last4, String(document.expires_on).slice(0, 10), document.notes], ["CDL", "Valid", "1234", "2030-01-01", "Class B"]);
    assert.ok(await q()("Employee Document Type").where({ name: "CDL" }).first());
    assert.equal(await has("Staffing Worker Document"), false);

    // Job opening, same code; the site became its location text.
    const opening = await q()("Job Opening").where({ name: "JOB-9001" }).first();
    assert.deepEqual([opening.title, opening.status, Number(opening.published), opening.job_position, opening.schedule, opening.location, Number(opening.openings)],
      ["Shuttle Driver — ATL", "Open", 1, "Shuttle Driver", "Nights", "ATL Rental Car Center", 2]);
    assert.equal(await has("Staffing Job Opening"), false);

    // Applicants: the pipeline is the Job Applicant; spam opens none.
    const forms = Object.fromEntries((await q()("Staffing Applicant").whereIn("name", ["APL-90001", "APL-90002", "APL-90003"])).map((a) => [a.name, a.job_applicant || null]));
    assert.equal(forms["APL-90003"], null);
    const hired = await q()("Job Applicant").where({ name: forms["APL-90001"] }).first();
    assert.deepEqual([hired.stage, hired.source, hired.job_opening, hired.job_position, hired.employee, hired.generator_name, String(hired.interview_at).slice(0, 16).replace("T", " ")],
      ["Hired", "Referral", "JOB-9001", "Shuttle Driver", "WRK-90001", "APL-90001", "2026-02-20 09:00"]);
    assert.match(hired.notes, /Requested role: Driver\nGreat attitude/);
    assert.equal((await q()("Employee").where({ name: "WRK-90001" }).first()).job_applicant, hired.name);
    const rejected = await q()("Job Applicant").where({ name: forms["APL-90002"] }).first();
    assert.deepEqual([rejected.stage, rejected.rejection_reason], ["Rejected", "Not Qualified"]);
    for (const c of ["stage", "worker", "recruiter_notes"]) assert.equal(await has("Staffing Applicant", c), false, `${c} dropped`);

    // Shift and timesheet, same codes; the site became its location and customer.
    const shift = await q()("Shift").where({ name: "SHF-90001" }).first();
    assert.deepEqual([shift.job_position, shift.location, shift.customer, shift.status, String(shift.shift_date).slice(0, 10), Number(shift.scheduled_hours), shift.notes],
      ["Shuttle Driver", place, customer, "Completed", "2026-10-05", 7.5, "Old shift"]);
    const seat = await q()("Shift Assignment").where({ parent_document: "Shift", parent_id: shift.id }).first();
    assert.deepEqual([seat.employee, seat.status, Number(seat.hours), Number(seat.check_in_distance_m)], ["WRK-90001", "Completed", 7.5, 12]);
    const sheet = await q()("Timesheet").where({ name: "TS-90001" }).first();
    assert.deepEqual([sheet.employee, sheet.status, String(sheet.week_start).slice(0, 10), Number(sheet.gross_pay), Number(sheet.billable_amount), sheet.payroll_batch],
      ["WRK-90001", "Exported", "2026-10-05", 157.5, 262.5, "PAY-OLD"]);
    const line = await q()("Timesheet Line").where({ parent_document: "Timesheet", parent_id: sheet.id }).first();
    assert.deepEqual([line.shift, line.location, line.customer, line.job_position, Number(line.hours), Number(line.pay_rate), Number(line.bill_rate), line.invoice],
      ["SHF-90001", place, customer, "Shuttle Driver", 7.5, 21, 35, "INV-OLD"]);
    for (const table of ["Staffing Shift", "Staffing Shift Assignment", "Staffing Timesheet", "Staffing Timesheet Line"]) assert.equal(await has(table), false, `${table} dropped`);

    // What the tenant kept of the removed entities is gone; the manager runs the erp's manager moves.
    assert.deepEqual((await q()("Workflow").select("name")).map((w) => w.name).filter((n) => n.startsWith("Staffing ")).sort(), ["Staffing Inquiry"]);
    assert.equal((await q()("Permission").select("document")).filter((p) => ["Staffing Shift", "Staffing Timesheet", "Staffing Job Opening", "Staffing Worker Document"].includes(p.document)).length, 0);
    const wf = await loopar.db.getRow("Workflow", "Timesheet", ["id"]);
    const approve = await q()("Workflow Transition").where({ parent_document: "Workflow", parent_id: wf.id, action: "Approve" }).first();
    assert.equal(approve.allowed_roles, "ERP Manager, HR Manager, Staffing Manager");

    // The old worker keeps working: its erp rates and the agency's default bill rate.
    const { timeRates } = await erp("hr", "employees.js");
    assert.deepEqual(await timeRates({ employee: "WRK-90001", job_position: "Shuttle Driver", location: place, customer, date: "2026-11-10" }), { pay_rate: 21, bill_rate: 35, overtime_multiplier: 1.5 });
  });

  // Idempotent: a second update changes nothing.
  await t.run(() => new Installer({ app_name: "staffing" }).install(true));
  await t.run(async () => {
    assert.equal(await loopar.db.count("Employee", { name: "WRK-90001" }), 1);
    assert.equal(await loopar.db.count("Employee Document", { employee: "WRK-90001" }), 1);
    assert.equal(Number((await q()("Job Applicant").whereIn("generator_name", ["APL-90001", "APL-90002"]).count({ c: "*" }).first()).c), 2);
    assert.equal(await loopar.db.count("Shift", { name: "SHF-90001" }), 1);
    assert.equal(await loopar.db.count("Timesheet", { name: "TS-90001" }), 1);
  });
});
