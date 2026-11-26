import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { loopar, requestContext, PermissionManager } from "loopar";
import { bootTestTenant } from "../support/tenant.js";

/*
 * Workforce Dashboard: the erp board of a customer's shifts (hr/workforce.js),
 * the production panels staffing adds (apps/staffing/hr.js), the portal
 * home card, and the activity simulator that feeds them in development.
 * A customer never sees another customer's people, locations or units.
 */

const root = process.cwd();
const imp = (...p) => import(path.join(root, "apps", ...p));
const as = (user, fn) => t.run(() => requestContext.run({ ...requestContext.getStore(), req: { __authUserName__: user, headers: {}, cookies: {} } }, fn));

let t, sim, board, page, home, demo, demoUser, other, otherUser, otherPlace;

// A fixed Wednesday morning: Monday and Tuesday are full days, today is under way.
const NOW = new Date(2026, 10, 18, 10, 30, 0);
const DATE = "2026-11-18";

before(async () => {
  t = await bootTestTenant({ apps: ["erp"] });
  const { default: Staffing } = await imp("staffing", "installer.js");
  await t.run(() => new Staffing({ app_name: "staffing" }).install());
  sim = await imp("staffing", "modules", "staffing", "shared", "simulator.js");
  board = await imp("erp", "modules", "hr", "workforce.js");
  page = await imp("erp", "modules", "hr", "pages", "workforce-dashboard", "workforce-dashboard-controller.js");
  home = await imp("loopar", "modules", "web", "pages", "portal-home", "portal-home-controller.js");
  await t.run(async () => { loopar.mail.send = async () => ({ ok: true }); });
});
after(async () => { await t?.teardown(); });

test("the simulator seeds a demo client and its week, and a second run adds nothing", async () => {
  await t.run(async () => {
    const first = await sim.simulateActivity(NOW);
    assert.match(first, /demo client created/);
    const user = /portal user (\S+)/.exec(first)?.[1];
    assert.ok(user, "the demo contact gets a portal user");
    demoUser = user;
    demo = await sim.ensureDemo();

    const shifts = await loopar.db.getAll("Shift", ["name", "shift_date", "status"], { location: demo.location });
    assert.equal(shifts.length, 18, "six shifts a day (one overnight), Monday to Wednesday");
    const ids = (await loopar.db.getAll("Shift", ["id"], { location: demo.location, shift_date: "2026-11-16" })).map((s) => s.id);
    const seats = await loopar.db.getAll("Shift Assignment", ["status", "parent_id"], { parent_document: "Shift" });
    const states = new Set(seats.filter((a) => ids.includes(a.parent_id)).map((a) => a.status));
    assert.ok(states.size && [...states].every((s) => ["Completed", "No Show"].includes(s)), `Monday is over (${[...states]})`);

    const events = await loopar.db.getAll("Staffing Unit Event", ["name", "event_at"], { station: demo.station });
    assert.ok(events.length > 100, `station events (${events.length})`);
    assert.ok(events.every((e) => new Date(String(e.event_at).replace(" ", "T")) <= NOW), "nothing after now");

    assert.match(await sim.simulateActivity(NOW), /0 shift\(s\) updated, 0 station event/);
  });
});

test("the board shows today's seats, coverage, attendance and the week", async () => {
  await t.run(async () => {
    const b = await board.workforceBoard({ customers: [demo.customer], date: DATE, now: NOW });
    assert.equal(b.kpis.needed_today, 18);
    assert.equal(b.kpis.filled_today, 17, "one porter seat stays open");
    assert.ok(b.roster.some((r) => r.state === "open"));
    assert.ok(b.kpis.on_site > 0 && b.kpis.on_site <= b.kpis.needed_now);
    assert.equal(b.kpis.needed_now, 11, "the morning porters, washers and drivers");
    assert.ok(b.kpis.attendance > 50);
    assert.ok(b.roster.every((r) => !r.name || /^\S+ [A-Z]\.$/.test(r.name)), "first name and initial only");
    assert.deepEqual(b.locations.map((l) => l.title), ["Simulated Rental Center"]);

    const [mon, tue, wed, thu] = b.week;
    assert.ok(mon.worked > 50 && tue.worked > 50, "Monday and Tuesday were worked");
    assert.ok(wed.today && wed.worked > 0 && wed.worked < mon.worked);
    assert.equal(thu.worked, 0);
    assert.ok(b.activity.length > 0 && b.activity.every((a) => new Date(a.at) <= NOW));

    const ops = b.panels.find((p) => p.kind === "kpis" && p.title === "Vehicle operations");
    assert.ok(ops, "staffing adds its production panel");
    assert.ok(ops.items.find((i) => i.label === "Stage moves today").value > 0);
    const weekUnits = b.panels.find((p) => p.kind === "bars");
    assert.ok(weekUnits.items[0].value > 0 && weekUnits.items[3].value === 0);
  });
});

test("late is decided by HR Settings' grace minutes", async () => {
  await t.run(async () => {
    const window = { start: new Date(2026, 10, 18, 6, 0), end: new Date(2026, 10, 18, 14, 30) };
    const at = (h, m) => new Date(2026, 10, 18, h, m);
    const seat = { status: "Confirmed" };
    assert.equal(board.seatState(seat, window, at(6, 4), 5 * 60000), "not_in");
    assert.equal(board.seatState(seat, window, at(6, 6), 5 * 60000), "late");
    assert.equal(board.seatState(seat, window, at(14, 31), 5 * 60000), "no_show");
    assert.equal(board.seatState({ status: "Checked In" }, window, at(7, 0), 0), "on_site");
    assert.equal(board.seatState({ status: "Cancelled" }, window, at(7, 0), 0), null);
  });
});

test("a customer only ever sees its own board, whatever it asks for", async () => {
  await t.run(async () => {
    const { createCustomer } = await loopar.api("Customer");
    const { createAddress } = await loopar.api("Customer Address");
    const { primaryContact, grantPortalAccess } = await loopar.api("Customer Contact");
    other = await createCustomer({ customer_name: "Other Logistics", email: "ops@other.test" });
    otherPlace = await createAddress({ customer: other, title: "Other Depot", city: "Atlanta" });
    const shift = await loopar.newDocument("Shift", {
      job_position: "Lot Porter", location: otherPlace, shift_date: DATE, start_time: "08:00:00", end_time: "16:00:00",
      break_minutes: 0, headcount: 2, assignments: [],
    });
    await shift.save();
    otherUser = (await grantPortalAccess(await primaryContact(other))).user;
  });

  const seen = (user, body) => as(user, async () => {
    const customers = await page.boardCustomers(body.customer);
    return await board.workforceBoard({ customers, location: body.location, date: DATE, now: NOW });
  });

  const mine = await seen(demoUser, { customer: other, location: otherPlace });
  assert.deepEqual(mine.locations.map((l) => l.name), [demo.location], "the requested customer and location are ignored");
  assert.equal(mine.location, null);
  assert.ok(!JSON.stringify(mine).includes("Other Depot"));

  const theirs = await seen(otherUser, {});
  assert.deepEqual(theirs.locations.map((l) => l.title), ["Other Depot"]);
  assert.equal(theirs.kpis.needed_today, 2);
  assert.equal(theirs.roster.filter((r) => r.name).length, 0);
  assert.deepEqual(theirs.panels, [], "no stations, no production panels");
  assert.ok(!JSON.stringify(theirs).includes("Simulated"));

  await assert.rejects(as(null, () => page.boardCustomers()), (e) => e.code === 401);
});

test("staff may open any customer's board; a desk user without customer access may not", async () => {
  const admin = await as("Administrator", () => page.boardCustomers(other));
  assert.deepEqual(admin, [other]);

  await t.run(async () => {
    await loopar.db.insertRow("User", { name: "clerk", email: "clerk@x.test", user_type: "System", password: await loopar.hash("Cl3rk-Passw0rd!") });
    await PermissionManager.reload("clerk");
  });
  await assert.rejects(as("clerk", () => page.boardCustomers(other)), (e) => e.code === 403);
});

test("the portal home shows the Workforce card to customers with shifts", async () => {
  await t.run(async () => {
    const withShifts = await home.portalSummary(demoUser);
    assert.deepEqual(withShifts.pages.map((p) => p.label), ["Workforce"]);
    assert.equal(withShifts.pages[0].href, "/portal/Workforce%20Dashboard/view");

    const { createCustomer } = await loopar.api("Customer");
    const { primaryContact, grantPortalAccess } = await loopar.api("Customer Contact");
    const quiet = await createCustomer({ customer_name: "No Shifts Inc", email: "hi@noshifts.test" });
    const quietUser = (await grantPortalAccess(await primaryContact(quiet))).user;
    assert.deepEqual((await home.portalSummary(quietUser)).pages, []);
  });
});

test("an open board is told when its customers' shifts or station scans change, and only then", async () => {
  const { RealtimeManager } = await import(path.join(root, "packages", "loopar", "core", "realtime", "RealtimeManager.js"));
  const live = await imp("erp", "modules", "hr", "workforce-live.js");
  const original = RealtimeManager.emit;
  const sent = [];
  // Only our notifications (the ORM also announces every write on __global__).
  RealtimeManager.emit = (tenant, room, event, payload) => { if (event === "workforce.changed") sent.push({ tenant, room, event, payload }); };
  try {
    let workspace;
    await t.run(async () => {
      workspace = loopar.tenantId;
      assert.equal(live.watchBoard(demoUser, [demo.customer]), `user:${demoUser}:workforce.changed`);
      live.watchBoard(otherUser, [other]);

      // A shift of the other customer.
      const shift = await loopar.newDocument("Shift", {
        job_position: "Lot Porter", location: otherPlace, shift_date: "2026-11-19", start_time: "08:00:00", end_time: "12:00:00",
        break_minutes: 0, headcount: 1, assignments: [],
      });
      await shift.save();
    });
    await new Promise((r) => setTimeout(r, 50));
    live._live.flushNow(workspace);
    assert.deepEqual(sent.map((m) => m.room), [`user:${otherUser}`], "only the other customer's viewer");
    assert.equal(sent[0].event, "workforce.changed");
    assert.equal(sent[0].payload.user, null, "no acting user travels");
    assert.deepEqual(Object.keys(sent[0].payload).sort(), ["at", "user"], "nothing about the change itself");

    // A station scan at the demo client's site.
    sent.length = 0;
    await t.run(async () => {
      await (await loopar.newDocument("Staffing Unit", { name: "LIVE01", client: demo.client })).save({ validate: false });
      const event = await loopar.newDocument("Staffing Unit Event", {
        unit: "LIVE01", stage: "Wash", event_at: new Date().toISOString(), station: demo.station, site: demo.site, client: demo.client, is_final: 0,
      });
      await event.save({ validate: false });
    });
    await new Promise((r) => setTimeout(r, 50));
    live._live.flushNow(workspace);
    assert.deepEqual(sent.map((m) => m.room), [`user:${demoUser}`]);

    // Writes nobody watches send nothing.
    sent.length = 0;
    await t.run(async () => { await loopar.db.setValue("Customer", "notes", "x", other).catch(() => {}); });
    live._live.flushNow(workspace);
    assert.deepEqual(sent, []);
  } finally {
    RealtimeManager.emit = original;
  }
});

test("the simulator stays off unless the workspace turns it on, and never in production", () => {
  const saved = { sim: process.env.STAFFING_SIMULATOR, env: process.env.NODE_ENV };
  try {
    delete process.env.STAFFING_SIMULATOR;
    assert.equal(sim.simulatorEnabled("dev"), false);
    process.env.STAFFING_SIMULATOR = "dev,test";
    assert.equal(sim.simulatorEnabled("dev"), true);
    assert.equal(sim.simulatorEnabled("prod"), false);
    delete process.env.STAFFING_SIMULATOR;
    const dir = path.join(root, "sites", "__sim_check__");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ staffingSimulator: true }));
    try {
      assert.equal(sim.simulatorEnabled("__sim_check__"), true, "turned on in the workspace's config");
      process.env.NODE_ENV = "production";
      assert.equal(sim.simulatorEnabled("__sim_check__"), false);
      assert.equal(sim.simulatorEnabled("dev"), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    if (saved.sim === undefined) delete process.env.STAFFING_SIMULATOR; else process.env.STAFFING_SIMULATOR = saved.sim;
    if (saved.env === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = saved.env;
  }
});
