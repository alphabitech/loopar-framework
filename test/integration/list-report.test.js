import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { loopar, requestContext, BaseController, PermissionManager, SCOPE } from "loopar";
import { bootTestTenant } from "../support/tenant.js";
import { keepInstallersUntouched } from "../support/no-installer-writes.js";

/**
 * List filters with an operator, the Report view's data, list totals and the
 * export — on a real entity (Service: `pricing_model` select, `price`
 * decimal, `order` int, `published` switch, `category` connection).
 */
const SERVICES = [
  // title, pricing_model, price, order, published
  ["Sanding", "fixed", 100, 1, 1],
  ["Staining", "fixed", 250.5, 2, 1],
  ["Install", "hourly", 80, 3, 0],
  ["Repair", "hourly", 40, 4, 1],
  ["Consulting", "custom", null, 5, 0],
  ["=Promo", "", 10, 6, 0],
];

let t;
const names = {};
before(async () => {
  t = await bootTestTenant();
  await t.run(async () => {
    await keepInstallersUntouched();
    await (await loopar.newDocument("Service Category", { name: "floors", title: "Floors" })).save();
    for (const [title, pricing_model, price, order, published] of SERVICES) {
      const slug = title.toLowerCase().replace(/[^a-z]/g, "");
      const doc = await loopar.newDocument("Service", {
        name: slug, app: "loopar", title, slug, pricing_model, price, order, published,
        category: ["Sanding", "Staining"].includes(title) ? "floors" : "",
      });
      await doc.save();
      names[title] = doc.name;
    }
  });
});
after(async () => { await t?.teardown(); });

const service = () => loopar.newDocument("Service");
const titles = async (q) => (await (await service()).getList({ q, pageSize: 50, fields: ["title"], sort: [{ field: "id", dir: "asc" }] })).rows.map((r) => r.title);

/** Runs `fn` as a request that targets the list of `document` with `query`. */
const asRequest = (document, query, fn) =>
  requestContext.run({ tenant: { name: t.name }, req: { query, __CONTROLLER__: { document } } }, fn);

test("filters with an operator narrow the list", async () => {
  await t.run(async () => {
    assert.deepEqual(await titles({ "price.gte": "100" }), ["Sanding", "Staining"]);
    assert.deepEqual(await titles({ "price.between": "40..100" }), ["Sanding", "Install", "Repair"]);
    assert.deepEqual(await titles({ "price.between": "..40" }), ["Repair", "=Promo"]);
    assert.deepEqual(await titles({ "pricing_model.in": "fixed,custom" }), ["Sanding", "Staining", "Consulting"]);
    assert.deepEqual(await titles({ "price.empty": "1" }), ["Consulting"]);
    assert.deepEqual(await titles({ "title.like": "ing", "price.lt": "200" }), ["Sanding"]);
    // "is not" keeps the records without a value.
    assert.deepEqual(await titles({ "pricing_model.ne": "fixed" }), ["Install", "Repair", "Consulting", "=Promo"]);
    assert.deepEqual(await titles({ "pricing_model.nin": "fixed,hourly" }), ["Consulting", "=Promo"]);
    assert.deepEqual(await titles({ "category.filled": "1" }), ["Sanding", "Staining"]);
    assert.deepEqual(await titles({ "published.eq": "0", "order.lte": "5" }), ["Install", "Consulting"]);
  });
});

test("the search form's bare filters keep working next to operators", async () => {
  await t.run(async () => {
    assert.deepEqual(await titles({ title: "stain" }), ["Staining"]);
    assert.deepEqual(await titles({ pricing_model: "hourly", "price.gt": "50" }), ["Install"]);
  });
});

test("filters that don't fit are dropped (and removed from q), never guessed", async () => {
  await t.run(async () => {
    const q = { "price.gte": "abc", "nope.gte": "1", "pricing_model.gt": "a", "title.like": "Sand" };
    const list = await (await service()).getList({ q, pageSize: 50, fields: ["title"] });
    assert.deepEqual(list.rows.map((r) => r.title), ["Sanding"]);
    assert.deepEqual(q, { "title.like": "Sand" });
  });
});

test("record dates filter when the table has them", async () => {
  await t.run(async () => {
    const today = new Date().toISOString().slice(0, 10);
    const doc = await service();
    const from = `${Number(today.slice(0, 4)) - 1}-01-01`;
    assert.equal((await doc.getList({ q: { "__created_at__.gte": from }, pageSize: 50 })).rows.length, SERVICES.length);
    assert.equal((await doc.getList({ q: { "__created_at__.lt": from }, pageSize: 50 })).rows.length, 0);
  });
});

test("reportData(): groups by a choice, counts and aggregates", async () => {
  await t.run(async () => {
    const report = await (await service()).reportData({
      groups: [{ field: "pricing_model", grain: null }],
      values: [{ fn: "sum", field: "price" }, { fn: "avg", field: "price" }, { fn: "min", field: "price" }, { fn: "max", field: "price" }],
    });

    assert.deepEqual(report.groups, [{ field: "pricing_model", label: report.groups[0].label, kind: "choice", grain: null }]);
    const byKey = Object.fromEntries(report.rows.map((r) => [r.keys[0], r]));
    assert.deepEqual(report.rows.map((r) => r.keys[0]), ["custom", "fixed", "hourly", ""], "by key, empty last");
    assert.equal(byKey.fixed.count, 2);
    assert.deepEqual(byKey.fixed.values, { "sum.price": 350.5, "avg.price": 175.25, "min.price": 100, "max.price": 250.5 });
    assert.deepEqual(byKey.hourly.values, { "sum.price": 120, "avg.price": 60, "min.price": 40, "max.price": 80 });
    // A group whose records have no value: counted, nothing to aggregate.
    assert.equal(byKey.custom.count, 1);
    assert.equal(byKey.custom.values["sum.price"], null);
    assert.deepEqual(report.totals, { count: 6, values: { "sum.price": 480.5, "avg.price": 480.5 / 5, "min.price": 10, "max.price": 250.5 } });
    assert.equal(report.groupCount, 4);
    assert.equal(report.truncated, false);
  });
});

test("reportData(): the list's filters apply; no group gives the totals alone", async () => {
  await t.run(async () => {
    const doc = await service();
    const report = await doc.reportData({ groups: [], values: [{ fn: "sum", field: "price" }], q: { "price.gte": "80" } });
    assert.equal(report.rows.length, 1);
    assert.deepEqual(report.rows[0].keys, []);
    assert.deepEqual(report.totals, { count: 3, values: { "sum.price": 430.5 } });

    const none = await doc.reportData({ groups: [{ field: "pricing_model" }], q: { title: "zzz" } });
    assert.deepEqual(none.rows, []);
    assert.equal(none.totals.count, 0);
  });
});

test("reportData(): dates group by their bucket; two levels; labels of switches and linked records", async () => {
  await t.run(async () => {
    const doc = await service();

    const byMonth = await doc.reportData({ groups: [{ field: "__created_at__", grain: "month" }] });
    assert.equal(byMonth.groups[0].kind, "datetime");
    assert.equal(byMonth.groups[0].grain, "month");
    assert.equal(byMonth.rows.length, 1, "every record of this run falls in one month");
    assert.match(byMonth.rows[0].keys[0], /^\d{4}-\d{2}$/);
    assert.equal(byMonth.rows[0].count, 6);

    // A date without a grain takes the default one.
    assert.equal((await doc.reportData({ groups: [{ field: "__created_at__" }] })).groups[0].grain, "month");

    const two = await doc.reportData({ groups: [{ field: "published" }, { field: "pricing_model" }], values: [{ fn: "sum", field: "price" }] });
    assert.deepEqual(two.rows.map((r) => r.keys.join("/")), ["0/custom", "0/hourly", "0/", "1/fixed", "1/hourly"]);
    assert.equal(two.rows[0].labels[0], "No");
    assert.equal(two.rows[3].labels[0], "Yes");
    assert.equal(two.rows.find((r) => r.keys.join("/") === "1/fixed").values["sum.price"], 350.5);

    const byCategory = await doc.reportData({ groups: [{ field: "category" }] });
    const floors = byCategory.rows.find((r) => r.keys[0] === "floors");
    assert.equal(floors.count, 2);
    assert.equal(floors.labels[0], "Floors", "a linked record reads as its title");
  });
});

test("reportData(): only real, readable fields group; only numbers aggregate", async () => {
  await t.run(async () => {
    const doc = await service();
    await assert.rejects(() => doc.reportData({ groups: [{ field: "nope" }] }), /can't group/);
    await assert.rejects(() => doc.reportData({ groups: [{ field: "id; drop table Service" }] }), /can't group/);
    await assert.rejects(() => doc.reportData({ values: [{ fn: "sum", field: "title" }] }), /not a number/);
  });
});

test("the list carries the sums of its numeric columns over every matching record", async () => {
  await asRequest("Service", { "price.gte": "40" }, async () => {
    const list = await loopar.getList("Service", { q: loopar.getQ("Service") });
    // `order` (int) is a list column of Service; the page holds fewer rows than the total.
    assert.equal(list.pagination.totalRecords, 4);
    assert.deepEqual(list.totals, { order: 1 + 2 + 3 + 4 });
  });
  // A list read on the side (not the request's target) carries none.
  await t.run(async () => {
    assert.equal((await (await service()).getList({ pageSize: 50 })).totals, null);
  });
});

test("exportRows(): every matching record, in order, as the list shows them", async () => {
  await t.run(async () => {
    const doc = await service();
    const out = await doc.exportRows({
      q: { "price.gte": "40" },
      fields: ["title", "pricing_model", "price", "published", "category", "nope", "seo_title"],
      sort: [{ field: "price", dir: "desc" }],
    });

    assert.equal(out.header.length, 7, "name first, unknown fields dropped");
    assert.equal(out.truncated, false);
    assert.deepEqual(out.rows.map((r) => r[1]), ["Staining", "Sanding", "Install", "Repair"]);
    const staining = out.rows[0];
    assert.equal(staining[0], names.Staining);
    assert.equal(Number(staining[3]), 250.5);
    assert.equal(staining[4], "Yes");
    assert.equal(staining[5], "Floors");
    assert.equal(out.rows[2][4], "No");
  });
});

test("exportRows(): only the picked records; the limit truncates", async () => {
  await t.run(async () => {
    const doc = await service();
    const picked = await doc.exportRows({ names: [names.Repair, names.Sanding, "nope"], fields: ["title"], sort: [{ field: "id", dir: "asc" }] });
    assert.deepEqual(picked.rows.map((r) => r[1]), ["Sanding", "Repair"]);

    const cut = await doc.exportRows({ fields: ["title"], limit: 2, sort: [{ field: "id", dir: "asc" }] });
    assert.equal(cut.rows.length, 2);
    assert.equal(cut.truncated, true);
  });
});

// ---- Controller actions ------------------------------------------------------

/** A desk request for `{document}/{action}` (RPC = POST), ready to run its action. */
const controller = (document, action, { query = {}, body = {}, method = "POST" } = {}) => {
  const req = { __WORKSPACE_NAME__: "desk", query, _parsedUrl: { query: new URLSearchParams(query).toString() } };
  const c = new BaseController({ document, action, method, query, body, data: body, req });
  req.__CONTROLLER__ = c;
  return c;
};
const run = (c, method) => requestContext.run({ tenant: { name: t.name }, req: c.req }, () => c[method]());

test("board, calendar and report are authorized by the list grant, with its scope; export needs its own", async () => {
  await t.run(async () => {
    const user = "viewer@loopar.test";
    await (await loopar.newDocument("User", {
      name: user, email: user, password: "Test-Password-123!", confirm_password: "Test-Password-123!",
    })).save();
    await loopar.db.insertRow("Permission", {
      name: "lr-viewer-service-list", relation: "User", relation_name: user, document: "Service", action: "list", scope: "own", deny: 0, app: "loopar",
    });
    await PermissionManager.reload(user);

    for (const action of ["list", "board", "calendar", "report"]) {
      const c = controller("Service", action);
      assert.equal(await c.isAuthorized({ name: user }), true, action);
      assert.equal(c.ownerScope(user), SCOPE.OWN, `${action} narrows like the list`);
    }
    await assert.rejects(() => controller("Service", "export").isAuthorized({ name: user }), /permission/i);

    // Aliased actions are not granted on their own: the permission manager doesn't offer them.
    const offered = (await PermissionManager.getAllActions()).filter((a) => a.document === "Service").map((a) => a.action.toLowerCase());
    assert.ok(offered.includes("list") && offered.includes("export"));
    for (const hidden of ["board", "calendar", "report", "changeprotected"]) assert.ok(!offered.includes(hidden), hidden);
  });
});

test("actionReport: the URL's report and filters", async () => {
  const c = controller("Service", "report", { query: { report: "pricing_model", report_values: "sum.price", report_chart: "line", "price.gte": "80", page: "3" } });
  const report = await run(c, "actionReport");
  assert.deepEqual(report.rows.map((r) => [r.keys[0], r.count, r.values["sum.price"]]), [["fixed", 2, 350.5], ["hourly", 1, 80]]);
  assert.deepEqual(report.totals, { count: 3, values: { "sum.price": 430.5 } });
});

test("actionExport: a CSV of the list, formula text made inert", async () => {
  const c = controller("Service", "export", { query: { "price.lte": "100", sort: "-price" }, body: { fields: ["title", "price"] } });
  const out = await run(c, "actionExport");
  assert.match(out.filename, /^service-\d{4}-\d{2}-\d{2}\.csv$/);
  assert.equal(out.rows, 4);
  assert.equal(out.truncated, false);
  const lines = out.csv.replace(/^\uFEFF/, "").trim().split("\r\n");
  assert.equal(lines.length, 5);
  assert.deepEqual(lines.slice(1).map((l) => l.split(",")[1]), ["Sanding", "Install", "Repair", "'=Promo"]);

  const picked = await run(controller("Service", "export", { body: { names: JSON.stringify([names.Repair]), fields: ["title"] } }), "actionExport");
  assert.equal(picked.rows, 1);
});

test("actionBoard / actionCalendar: the views' data, with their own parameters left out of the filters", async () => {
  await t.run(async () => {
    const { createProject } = await import(`${process.cwd()}/apps/loopar/modules/projects/projects.js`);
    const { createCustomer } = await import(`${process.cwd()}/apps/loopar/modules/crm/customers.js`);
    const customer = await createCustomer({ customer_name: "Jane Doe", email: "jane@example.test" });
    await createProject({ title: "Kitchen floor", customer, city: "Boston" });
  });

  const column = await run(controller("Project", "board", { query: { board: "Planned", title: "kitchen" } }), "actionBoard");
  assert.equal(column.state, "Planned");
  assert.deepEqual(column.rows.map((r) => r.title), ["Kitchen floor"]);
  assert.equal(column.total, 1);

  const tray = await run(controller("Project", "calendar", { query: { calendar: "unscheduled" } }), "actionCalendar");
  assert.ok(Array.isArray(tray.rows));
  const range = await run(controller("Project", "calendar", { query: { cal_from: "2026-01-01", cal_to: "2026-12-31" } }), "actionCalendar");
  assert.equal(range.from, "2026-01-01");
  await assert.rejects(() => run(controller("Project", "calendar", { query: { cal_from: "nope" } }), "actionCalendar"), /Calendar range/);

  // The list action no longer answers for the views.
  await assert.rejects(() => run(controller("Service", "board", { query: { board: "x" } }), "actionBoard"), /no active workflow/);
});

test("a data action opened as a page leads to the list, keeping its query", async () => {
  const c = controller("Service", "report", { method: "GET", query: { report: "pricing_model", "price.gte": "80" } });
  const out = await run(c, "actionReport");
  assert.equal(out.redirect, "list?report=pricing_model&price.gte=80");
});
