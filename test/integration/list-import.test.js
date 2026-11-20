import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  loopar, requestContext, BaseController, PermissionManager,
  importRecords, listSavedViews, writeSavedView, deleteSavedView, scheduleSavedView, sendScheduledViews,
} from "loopar";
import { bulkUpdateRecords, bulkTransitionRecords } from "../../packages/loopar/core/document/list-bulk.js";
import { scheduledEmailDue, emailRecipients } from "../../packages/loopar/core/document/saved-views.js";
import { bootTestTenant } from "../support/tenant.js";
import { keepInstallersUntouched } from "../support/no-installer-writes.js";

/** Import of records (Service) and saved views of a list. */
let t;
before(async () => {
  t = await bootTestTenant({ apps: ["erp"] });
  await t.run(async () => {
    await keepInstallersUntouched();
    await (await loopar.newDocument("Service Category", { name: "floors", title: "Floors" })).save();
    await (await loopar.newDocument("Service", { name: "sanding", app: "loopar", title: "Sanding", slug: "sanding", price: 100, order: 1 })).save();
  });
});
after(async () => { await t?.teardown(); });

const service = (name) => loopar.db.qx()("Service").where({ name }).whereNull("__deleted_at__").first();

test("dry run validates every row and writes nothing", async () => {
  await t.run(async () => {
    const result = await importRecords("Service", {
      dryRun: true,
      records: [
        { name: "staining", app: "loopar", title: "Staining", slug: "staining", price: "$1,250.50", published: "yes", pricing_model: "Fixed", category: "Floors" },
        { name: "broken", app: "loopar", title: "Broken", slug: "broken", price: "abc", pricing_model: "weekly" },
        { title: "No app" },
        {},
      ],
    }, "Administrator");

    assert.deepEqual([result.total, result.created, result.updated, result.failed, result.dry_run], [4, 1, 0, 3, true]);
    assert.deepEqual(result.issues.map((i) => i.row), [3, 4, 5], "rows count as the file does: header is row 1");
    assert.match(result.issues[0].message, /Price: "abc" is not a number; .*"weekly" is not an option/);
    assert.match(result.issues[1].message, /required/i);
    assert.match(result.issues[2].message, /empty/i);
    assert.equal(await service("staining"), undefined);
  });
});

test("insert: new records go through the document; an existing name fails on its own", async () => {
  await t.run(async () => {
    const result = await importRecords("Service", {
      records: [
        { name: "staining", app: "loopar", title: "Staining", slug: "staining", price: "$1,250.50", published: "yes", pricing_model: "Fixed", category: "Floors" },
        { name: "sanding", app: "loopar", title: "Again", slug: "sanding-2" },
        { name: "install", app: "loopar", title: "Install", slug: "install", category: "floors", order: "7" },
        { name: "ghost", app: "loopar", title: "Ghost", slug: "ghost", category: "Nowhere" },
      ],
    }, "Administrator");

    assert.deepEqual([result.created, result.updated, result.failed], [2, 0, 2]);
    assert.match(result.issues[0].message, /already exists/);
    assert.match(result.issues[1].message, /"Nowhere" is not a Service Category/);

    const staining = await service("staining");
    assert.equal(Number(staining.price), 1250.5);
    assert.equal(Number(staining.published), 1);
    assert.equal(staining.pricing_model, "fixed", "the option's label became its value");
    assert.equal(staining.category, "floors", "the linked record's title became its name");
    assert.ok(staining.__created_at__);
    assert.equal(Number((await service("install")).order), 7);
    assert.equal((await service("sanding")).title, "Sanding", "untouched");
  });
});

test("upsert: a known name updates only the cells that say something", async () => {
  await t.run(async () => {
    const result = await importRecords("Service", {
      mode: "upsert",
      records: [
        { name: "sanding", price: "150", title: "", tagline: "Dustless" },
        { name: "repair", app: "loopar", title: "Repair", slug: "repair" },
      ],
    }, "Administrator");

    assert.deepEqual([result.created, result.updated, result.failed], [1, 1, 0]);
    const sanding = await service("sanding");
    assert.equal(Number(sanding.price), 150);
    assert.equal(sanding.tagline, "Dustless");
    assert.equal(sanding.title, "Sanding", "an empty cell keeps the stored value");
    assert.equal(Number(sanding.order), 1);
  });
});

test("the import needs create / update for what its rows do", async () => {
  await t.run(async () => {
    const user = "importer@loopar.test";
    await (await loopar.newDocument("User", { name: user, email: user, password: "Test-Password-123!", confirm_password: "Test-Password-123!" })).save();
    const grant = (action, scope = "all") => loopar.db.insertRow("Permission", {
      name: `li-${action}`, relation: "User", relation_name: user, document: "Service", action, scope, deny: 0, app: "loopar",
    });
    await grant("import");
    await PermissionManager.reload(user);

    const records = [{ name: "sanding", price: "1" }, { name: "new-one", app: "loopar", title: "New", slug: "new-one" }];
    let result = await importRecords("Service", { mode: "upsert", records }, user);
    assert.deepEqual([result.created, result.updated, result.failed], [0, 0, 2]);
    assert.match(result.issues.map((i) => i.message).join("|"), /permission to update.*permission to create/);

    // 'own' update: only the records this user created.
    await grant("create");
    await grant("update", "own");
    await PermissionManager.reload(user);
    result = await importRecords("Service", { mode: "upsert", records }, user);
    assert.deepEqual([result.created, result.updated, result.failed], [1, 0, 1]);
    assert.match(result.issues[0].message, /permission over this record/);
    assert.equal(Number((await service("sanding")).price), 150);

    // The action itself is authorized by the `import` grant.
    const request = (action) => new BaseController({ document: "Service", action, method: "POST", body: {}, req: { __WORKSPACE_NAME__: "desk" } });
    assert.equal(await request("import").isAuthorized({ name: user }), true);
    await assert.rejects(() => request("export").isAuthorized({ name: user }), /permission/i);
  });
});

test("limits: an empty file, too many rows, entities that take no records", async () => {
  await t.run(async () => {
    await assert.rejects(() => importRecords("Service", { records: [] }, "Administrator"), /no rows/);
    await assert.rejects(() => importRecords("Service", { records: Array.from({ length: 5001 }, () => ({ title: "x" })) }, "Administrator"), /up to 5000/);
    await assert.rejects(() => importRecords("System Settings", { records: [{ a: 1 }] }, "Administrator"), /does not take imported/);
  });
});

test("actionImport: records, mode and dry run from the body", async () => {
  const body = { mode: "upsert", dry_run: "1", records: JSON.stringify([{ name: "sanding", price: "175" }]) };
  const req = { __WORKSPACE_NAME__: "desk", query: {}, _parsedUrl: { query: "" } };
  const c = new BaseController({ document: "Service", action: "import", method: "POST", query: {}, body, data: body, req });
  req.__CONTROLLER__ = c;
  const result = await requestContext.run({ tenant: { name: t.name }, req }, () => c.actionImport());
  // No session in this request: the row is read (upsert of an existing name, dry run) and refused for the guest.
  assert.deepEqual([result.total, result.updated, result.failed, result.dry_run], [1, 0, 1, true]);
  assert.match(result.issues[0].message, /permission to update/);
  assert.equal(result.issues[0].row, 2);
});

// ---- Saved views -------------------------------------------------------------

test("saved views: private by default, shared ones reach everyone who may list", async () => {
  await t.run(async () => {
    const ana = "ana@loopar.test", bob = "bob@loopar.test", eve = "eve@loopar.test";
    for (const user of [ana, bob, eve]) {
      await (await loopar.newDocument("User", { name: user, email: user, password: "Test-Password-123!", confirm_password: "Test-Password-123!" })).save();
    }
    for (const user of [ana, bob]) {
      await loopar.db.insertRow("Permission", { name: `sv-${user}`, relation: "User", relation_name: user, document: "Service", action: "list", scope: "all", deny: 0, app: "loopar" });
      await PermissionManager.reload(user);
    }

    const mine = await writeSavedView("Service", {
      title: "  Expensive   ones ", view_type: "Grid", query: "?price.gte=100&sort=-price&page=3&workspace=desk&preloaded=true",
    }, ana);
    assert.deepEqual([mine.title, mine.query, mine.view_type, mine.shared, mine.mine], ["Expensive ones", "price.gte=100&sort=-price", "Grid", false, true]);

    const shared = await writeSavedView("Service", {
      title: "By category", view_type: "Report", shared: true, query: "report=category&report_values=sum.price&published=1",
    }, ana);
    assert.equal(shared.query, "report=category&report_values=sum.price&published=1");

    assert.deepEqual((await listSavedViews("Service", ana)).map((v) => v.title), ["By category", "Expensive ones"]);
    const forBob = await listSavedViews("Service", bob);
    assert.deepEqual(forBob.map((v) => [v.title, v.mine, v.shared]), [["By category", false, true]]);

    // Same title: the user's own view is replaced, not duplicated.
    const again = await writeSavedView("Service", { title: "Expensive ones", view_type: "Weird", query: "price.gte=500" }, ana);
    assert.equal(again.name, mine.name);
    assert.deepEqual([again.query, again.view_type], ["price.gte=500", "List"]);
    assert.equal((await listSavedViews("Service", ana)).length, 2);

    // Only its owner changes or removes a view; without the list grant there are no views at all.
    await assert.rejects(() => writeSavedView("Service", { name: shared.name, title: "Hijacked" }, bob), /not found/i);
    await assert.rejects(() => deleteSavedView(shared.name, bob), /not found/i);
    await assert.rejects(() => listSavedViews("Service", eve), /permission/i);
    await assert.rejects(() => writeSavedView("Service", { title: "x" }, eve), /permission/i);
    await assert.rejects(() => listSavedViews("Service", "Guest"), /logged in/i);
    await assert.rejects(() => writeSavedView("Service", { title: "  " }, ana), /title/i);

    await deleteSavedView(shared.name, ana);
    assert.deepEqual(await listSavedViews("Service", bob), []);
    await deleteSavedView(mine.name, "Administrator");
    assert.deepEqual(await listSavedViews("Service", ana), []);
  });
});

// ---- Bulk actions ----------------------------------------------------------------

test("bulk edit: one field on every selected record, read as an import cell", async () => {
  await t.run(async () => {
    const result = await bulkUpdateRecords("Service", { names: ["sanding", "staining", "nope", "sanding"], field: "pricing_model", value: "Hourly" }, "Administrator");
    assert.deepEqual([result.total, result.done, result.failed], [3, 2, 1]);
    assert.deepEqual(result.issues.map((i) => i.name), ["nope"]);
    assert.equal((await service("sanding")).pricing_model, "hourly");
    assert.equal((await service("staining")).pricing_model, "hourly");

    const off = await bulkUpdateRecords("Service", { names: ["staining"], field: "published", value: "0" }, "Administrator");
    assert.equal(off.done, 1);
    assert.equal(Number((await service("staining")).published), 0);

    const bad = await bulkUpdateRecords("Service", { names: ["sanding"], field: "pricing_model", value: "weekly" }, "Administrator");
    assert.deepEqual([bad.done, bad.failed], [0, 1]);
    assert.match(bad.issues[0].message, /not an option/);

    await assert.rejects(() => bulkUpdateRecords("Service", { names: ["sanding"], field: "name", value: "x" }, "Administrator"), /can't be edited in bulk/);
    await assert.rejects(() => bulkUpdateRecords("Service", { names: ["sanding"], field: "nope", value: "x" }, "Administrator"), /can't be edited in bulk/);
    await assert.rejects(() => bulkUpdateRecords("Service", { names: ["sanding"], field: "title", value: " " }, "Administrator"), /needs a value/);
    await assert.rejects(() => bulkUpdateRecords("Service", { names: [], field: "title", value: "x" }, "Administrator"), /at least one/);
  });
});

test("bulk transition: each record moves through its workflow, or fails on its own", async () => {
  await t.run(async () => {
    const { createProject } = await import(`${process.cwd()}/apps/erp/modules/projects/projects.js`);
    const { createCustomer } = await import(`${process.cwd()}/apps/erp/modules/crm/customers.js`);
    const customer = await createCustomer({ customer_name: "Jane Doe", email: "jane@example.test" });
    const a = await createProject({ title: "Kitchen", customer }, { document: "Customer", documentName: customer });
    const workflow = await loopar.db.qx()("Workflow").where({ name: "Project" }).first();
    const transition = (await loopar.db.qx()("Workflow Transition").where({ parent_document: "Workflow", parent_id: workflow.id }))
      .find((row) => String(row.from_state ?? row.from ?? "").includes("Planned"));
    assert.ok(transition, "a transition out of Planned");

    const result = await bulkTransitionRecords("Project", { names: [a, "PRJ-nope"], action: transition.action });
    assert.deepEqual([result.total, result.failed], [2, result.total - result.done]);
    assert.ok(result.issues.some((i) => i.name === "PRJ-nope"));
    await assert.rejects(() => bulkTransitionRecords("Project", { names: [a], action: "" }), /Pick the action/);
  });
});

test("the bulk actions are authorized by update / transition", async () => {
  await t.run(async () => {
    const user = "bulk@loopar.test";
    await (await loopar.newDocument("User", { name: user, email: user, password: "Test-Password-123!", confirm_password: "Test-Password-123!" })).save();
    await loopar.db.insertRow("Permission", { name: "bk-update", relation: "User", relation_name: user, document: "Service", action: "update", scope: "all", deny: 0, app: "loopar" });
    await PermissionManager.reload(user);
    const request = (action) => new BaseController({ document: "Service", action, method: "POST", body: {}, req: { __WORKSPACE_NAME__: "desk" } });
    assert.equal(await request("bulkUpdate").isAuthorized({ name: user }), true);
    await assert.rejects(() => request("bulkTransition").isAuthorized({ name: user }), /permission/i);
    await assert.rejects(() => request("bulkDelete").isAuthorized({ name: user }), /permission/i);
  });
});

// ---- Scheduled emails of saved views ---------------------------------------------

test("scheduledEmailDue() / emailRecipients()", () => {
  const at = (text) => new Date(text);
  assert.equal(scheduledEmailDue("daily", null, at("2026-11-17T08:00:00")), true);
  assert.equal(scheduledEmailDue("daily", "2026-11-17", at("2026-11-17T08:00:00")), false, "once a day");
  assert.equal(scheduledEmailDue("daily", "2026-11-16", at("2026-11-17T03:00:00")), false, "not before the morning");
  assert.equal(scheduledEmailDue("weekly", null, at("2026-11-16T08:00:00")), true, "a Monday");
  assert.equal(scheduledEmailDue("weekly", null, at("2026-11-17T08:00:00")), false);
  assert.equal(scheduledEmailDue("monthly", null, at("2026-12-01T08:00:00")), true);
  assert.equal(scheduledEmailDue("monthly", null, at("2026-12-02T08:00:00")), false);
  assert.equal(scheduledEmailDue("none", null, at("2026-11-17T08:00:00")), false);
  assert.deepEqual(emailRecipients("Ana@X.com; bob@y.org, nope, ana@x.com\n c@z.io"), ["ana@x.com", "bob@y.org", "c@z.io"]);
});

test("a scheduled view is emailed once when due: its table inline and as CSV", async () => {
  await t.run(async () => {
    const sent = [];
    const mail = loopar.mail;
    const realSend = mail.send;
    mail.send = async (message) => { sent.push(message); return { messageId: "test" }; };
    try {
      const list = await writeSavedView("Service", { title: "Hourly ones", view_type: "List", query: "pricing_model=hourly&sort=name" }, "Administrator");
      const report = await writeSavedView("Service", { title: "By model", view_type: "Report", query: "report=pricing_model&report_values=sum.price" }, "Administrator");

      const scheduled = await scheduleSavedView(list.name, { schedule: "daily", to: "boss@loopar.test, nope" }, "Administrator");
      assert.deepEqual([scheduled.email_schedule, scheduled.email_to], ["daily", "boss@loopar.test"]);
      // Without recipients it goes to the owner.
      const own = await scheduleSavedView(report.name, { schedule: "daily" }, "Administrator");
      assert.ok(own.email_to.includes("@"), `owner address: ${own.email_to}`);

      const morning = new Date(); morning.setHours(9, 0, 0, 0);
      assert.match(await sendScheduledViews(morning), /^2 view\(s\) sent/);
      assert.equal(sent.length, 2);

      const listMail = sent.find((m) => m.subject.startsWith("Hourly ones"));
      assert.deepEqual(listMail.to, ["boss@loopar.test"]);
      assert.match(listMail.html, /Sanding/);
      assert.match(listMail.attachments[0].filename, /^service-hourly-ones-\d{4}-\d{2}-\d{2}\.csv$/);
      assert.match(listMail.attachments[0].content, /sanding/);

      const reportMail = sent.find((m) => m.subject.startsWith("By model"));
      assert.match(reportMail.html, /Records/);
      assert.match(reportMail.attachments[0].content, /Total/);

      // Same day: nothing more. Before the morning: nothing either.
      assert.match(await sendScheduledViews(morning), /^0 view\(s\) sent/);
      assert.equal(sent.length, 2);

      // Stopping a schedule; only the owner sets one, and only with the export grant over everything.
      assert.equal((await scheduleSavedView(list.name, { schedule: "none" }, "Administrator")).email_schedule, "none");
      await assert.rejects(() => scheduleSavedView(list.name, { schedule: "daily" }, "ana@loopar.test"), /not found/i);
      const anas = await writeSavedView("Service", { title: "Ana's" }, "ana@loopar.test");
      await assert.rejects(() => scheduleSavedView(anas.name, { schedule: "daily", to: "x@y.io" }, "ana@loopar.test"), /export/i);
    } finally {
      mail.send = realSend;
    }
  });
});
