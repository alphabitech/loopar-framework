import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { loopar, applyTransition } from "loopar";
import { bootTestTenant } from "../support/tenant.js";
import { createProject, projectOf, projectsAvailable } from "../../apps/erp/modules/projects/projects.js";
import { createCustomer } from "../../apps/erp/modules/crm/customers.js";

let t;
before(async () => { t = await bootTestTenant({ apps: ["erp"] }); });
after(async () => { await t?.teardown(); });

const q = () => loopar.db.qx();
const indexesOf = async (table) => (await q().raw("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL", [table])).map(r => r.name).sort();
// An update of the site: the framework first, then the erp app (Project lives there).
const updateLoopar = async () => {
  for (const app of ["loopar", "erp"]) {
    const { default: Installer } = await import(`${process.cwd()}/apps/${app}/installer.js`);
    await new Installer({ app_name: app }).install(true);
  }
};

test("a fresh install ships the projects module and the renamed portfolio entity", async () => {
  await t.run(async () => {
    assert.equal(projectsAvailable(), true);
    for (const entity of ["Project", "Project Update", "Portfolio Project"]) {
      assert.ok(loopar.getRef(entity), `ref for ${entity}`);
      assert.equal(await loopar.db.count("Entity", { name: entity }), 1, `Entity record for ${entity}`);
      assert.equal(await q().schema.hasTable(entity), true, `table of ${entity}`);
    }
    assert.equal(await loopar.db.getValue("Entity", "module", "Project"), "projects");
    assert.equal(await loopar.db.getValue("Entity", "module", "Portfolio Project"), "Web");
    assert.equal(await q().schema.hasColumn("Project", "customer"), true);
    assert.equal(await q().schema.hasColumn("Portfolio Project", "slug"), true);
    // A public `collection` only lists entities with a `published` column: Project must never have one.
    assert.equal(await q().schema.hasColumn("Project", "published"), false);
    assert.equal(await loopar.db.testFramework("loopar"), true);
  });
});

test("the Project workflow is seeded with its states and transitions", async () => {
  await t.run(async () => {
    const workflow = await q()("Workflow").where({ name: "Project" }).first();
    assert.equal(workflow?.document, "Project");
    assert.equal(workflow.state_field, "status");
    const states = await q()("Workflow State").where({ parent_document: "Workflow", parent_id: workflow.id });
    const transitions = await q()("Workflow Transition").where({ parent_document: "Workflow", parent_id: workflow.id });
    assert.deepEqual(states.map(s => s.state).sort(), ["Cancelled", "Completed", "In Progress", "On Hold", "Planned"]);
    assert.equal(transitions.length, 5);
  });
});

test("createProject: one project per source record; the state only moves through the workflow", async () => {
  await t.run(async () => {
    const customer = await createCustomer({ customer_name: "Jane Doe", email: "jane@example.test" });
    const source = { document: "Customer", documentName: customer };

    const name = await createProject({ title: "  Kitchen   floor ", customer, city: "Boston" }, source);
    assert.match(name, /^PRJ-/);
    assert.equal(await createProject({ title: "Again", customer }, source), name, "same source → same project");
    assert.equal(await projectOf("Customer", customer), name);

    const project = await loopar.getDocument("Project", name);
    assert.equal(project.title, "Kitchen floor");
    assert.equal(project.status, "Planned");

    project.status = "Completed";
    await project.save();
    assert.equal(await loopar.db.getValue("Project", "status", name), "Planned", "a plain save keeps the state");

    const moved = await applyTransition(await loopar.getDocument("Project", name), "Start", {}, { system: true });
    assert.equal(moved.state, "In Progress");
    assert.equal(await loopar.db.getValue("Project", "status", name), "In Progress");

    const update = await loopar.newDocument("Project Update", { project: name, note: "Demo done" });
    await update.save();
    assert.match(update.name, /^PUP-/);
    assert.ok(update.update_date, "date defaults to today");
    await assert.rejects(async () => (await loopar.newDocument("Project Update", { project: "PRJ-nope" })).save());

    // The "Updates" panel of the Project form reads them newest first, with their photos.
    const older = await loopar.newDocument("Project Update", {
      project: name, update_date: "2020-01-05", stage: "Before",
      photos: JSON.stringify([{ name: "a.jpg", src: "/uploads/public/a.jpg" }, { name: "broken" }]),
    });
    await older.save();
    const { default: ProjectController } = await import(`${process.cwd()}/apps/erp/modules/projects/entities/project/project-controller.js`);
    const { updates } = await new ProjectController({ name }).actionUpdates();
    assert.deepEqual(updates.map(u => u.name), [update.name, older.name]);
    assert.equal(updates[0].note, "Demo done");
    assert.deepEqual(updates[1], { name: older.name, date: "2020-01-05", stage: "Before", note: "", by: updates[1].by, photos: [{ name: "a.jpg", src: "/uploads/public/a.jpg" }] });
    await assert.rejects(() => new ProjectController({ name: "PRJ-nope" }).actionUpdates());
  });
});

test("updating a tenant from before the rename: the old Project becomes Portfolio Project, the new one takes the name", async () => {
  await t.run(async () => {
    // Put the tenant back to how it was before: `Project` is the portfolio entity.
    const workflow = await q()("Workflow").where({ name: "Project" }).first();
    await q()("Workflow State").where({ parent_document: "Workflow", parent_id: workflow.id }).delete();
    await q()("Workflow Transition").where({ parent_document: "Workflow", parent_id: workflow.id }).delete();
    await q()("Workflow").where({ id: workflow.id }).delete();
    await q()("Project Update").delete();
    await q().schema.dropTable("Project");
    await q()("Entity").where({ name: "Project" }).delete();
    await q().schema.renameTable("Portfolio Project", "Project");
    await q()("Entity").where({ name: "Portfolio Project" }).update({ name: "Project" });
    // …and its indexes carry that name (SQLite index names are unique per database).
    for (const name of await indexesOf("Project")) await q().raw("DROP INDEX ??", [name]);
    await q().raw("CREATE UNIQUE INDEX `project_name_unique` ON `Project` (`name`)");
    await q().raw("CREATE INDEX `project___created_by___index` ON `Project` (`__created_by__`)");

    await q()("Project").insert({ name: "Old Showcase", title: "Old Showcase", slug: "old-showcase", app: "loopar", published: 1 });
    await q()("Document History").insert({ name: "h-portfolio", document: "Project", document_name: "Old Showcase", action: "update" });
    await loopar.db.insertRow("Entity", {
      name: "Uses Portfolio", module: "core",
      doc_structure: JSON.stringify([{ element: "collection", data: { name: "list", options: "Project" } }]),
    });

    await updateLoopar();

    const portfolio = await q()("Portfolio Project").select("name", "slug");
    assert.deepEqual(portfolio.map(r => r.name), ["Old Showcase"], "portfolio data moved with its table");
    assert.equal(portfolio[0].slug, "old-showcase");
    assert.equal((await q()("Entity").where({ name: "Portfolio Project" }).first())?.module, "Web");

    assert.equal((await q()("Entity").where({ name: "Project" }).first())?.module, "projects");
    assert.equal(await q().schema.hasColumn("Project", "customer"), true, "Project is the new table");
    assert.equal(await q().schema.hasColumn("Project", "slug"), false);
    assert.equal(Number((await q()("Project").count({ c: "*" }).first()).c), 0);
    assert.deepEqual(await indexesOf("Portfolio Project"), ["portfolio project___created_by___index", "portfolio project_name_unique"], "indexes follow the renamed table");
    assert.deepEqual(await indexesOf("Project"), ["project___created_by___index", "project_name_unique"], "the new Project owns its index names");

    assert.equal((await q()("Document History").where({ name: "h-portfolio" }).first()).document, "Portfolio Project");
    const page = await q()("Entity").where({ name: "Uses Portfolio" }).first();
    assert.equal(JSON.parse(page.doc_structure)[0].data.options, "Portfolio Project");
    assert.equal((await q()("Workflow").where({ name: "Project" }).first())?.document, "Project");

    // Every later update finds both names: the replay must leave the new Project alone.
    const customer = await createCustomer({ customer_name: "John Roe" });
    const project = await createProject({ title: "Stairs", customer });
    await updateLoopar();
    assert.equal((await q()("Workflow").where({ name: "Project" }).first())?.document, "Project");
    assert.equal(await loopar.db.getValue("Project", "title", project), "Stairs");
    assert.deepEqual((await q()("Portfolio Project").select("name")).map(r => r.name), ["Old Showcase"]);
    assert.equal(await q().schema.hasColumn("Portfolio Project", "customer"), false, "tables did not get mixed");

    // A tenant renamed before index names followed their table: Project lost
    // its unique index to Portfolio Project. The next update repairs both.
    for (const name of [...await indexesOf("Project"), ...await indexesOf("Portfolio Project")]) await q().raw("DROP INDEX ??", [name]);
    await q().raw("CREATE UNIQUE INDEX `project_name_unique` ON `Portfolio Project` (`name`)");
    await updateLoopar();
    assert.ok((await indexesOf("Portfolio Project")).includes("portfolio project_name_unique"));
    assert.ok((await indexesOf("Project")).includes("project_name_unique"), "UNIQUE(name) is back on Project");
    await assert.rejects(() => q()("Project").insert({ name: project, title: "dup", customer }), /UNIQUE/i);
    assert.equal(await loopar.db.testFramework("loopar"), true);
  });
});
