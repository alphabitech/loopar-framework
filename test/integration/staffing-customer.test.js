import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loopar, CHILD_POSITION_COLUMN } from "loopar";
import { bootTestTenant } from "../support/tenant.js";

/*
 * Staffing on the core Customer: a Staffing Client keeps only its staffing
 * data and a `customer` link. Covers the 1.12.0 data migration (old client
 * columns and Staffing Client Contact rows → Customer + Customer Contacts),
 * the readers (title, select search, billing contact) and the inquiry flow.
 */

const root = process.cwd();
const staffing = (...p) => import(path.join(root, "apps", "staffing", ...p));

let t;
let Installer;
let clients;
before(async () => {
  t = await bootTestTenant();
  ({ default: Installer } = await staffing("installer.js"));
  clients = await staffing("modules", "staffing", "shared", "clients.js");
  await t.run(() => new Installer({ app_name: "staffing" }).install());
});
after(async () => { await t?.teardown(); });

const q = () => loopar.db.qx();
const OLD_CONTACT = "Staffing Client Contact";

test("an update migrates old clients and their contacts to core Customers", async () => {
  await t.run(async () => {
    // Recreate the pre-1.12.0 shape: old columns, the old child table and its meta row.
    await q().schema.alterTable("Staffing Client", (tb) => {
      for (const c of ["company_name", "phone", "email", "billing_address", "billing_city", "billing_state", "billing_zip_code"]) tb.string(c).nullable();
    });
    await q().schema.createTable(OLD_CONTACT, (tb) => {
      tb.increments("id");
      tb.string("name").unique();
      tb.integer("parent_id");
      tb.string("parent_document");
      tb.string("full_name");
      tb.string("job_title");
      tb.string("email");
      tb.string("phone");
      tb.integer("is_primary");
      tb.string("portal_user");
      tb.integer(CHILD_POSITION_COLUMN).nullable();
    });
    await q()("Entity").insert({ name: OLD_CONTACT, module: "staffing-sales", is_child: 1, doc_structure: "[]" });
    await q()("Permission").insert({ name: "Role-Staffing Sales-Old Contact", relation: "Role", relation_name: "Staffing Sales", document: OLD_CONTACT, action: "view", deny: 0, app: "staffing" });

    const portal = await loopar.newDocument("User");
    Object.assign(portal, {
      name: "jane@acme.test", email: "jane@acme.test", first_name: "Jane", user_type: "Web",
      password: "Portal-Pass-123!", confirm_password: "Portal-Pass-123!", __document_status__: "Active",
    });
    await portal.save({ validate: false });

    await q()("Staffing Client").insert({
      name: "CLI-9001", customer: "", status: "Active", industry: "Parking", payment_terms: "Net 45",
      company_name: "  Acme   Parking ", email: "AP@acme.test", phone: "555-0100",
      billing_address: "1 Main St", billing_city: "Atlanta", billing_state: "GA", billing_zip_code: "30301",
    });
    const { id } = await loopar.db.getRow("Staffing Client", "CLI-9001", ["id"]);
    await q()(OLD_CONTACT).insert([
      { name: "c1", parent_id: id, parent_document: "Staffing Client", full_name: "John Ops", job_title: "Ops", email: "john@acme.test", is_primary: 0, [CHILD_POSITION_COLUMN]: 0 },
      { name: "c2", parent_id: id, parent_document: "Staffing Client", full_name: "Jane Boss", job_title: "CFO", email: "Jane@acme.test", is_primary: 1, portal_user: "jane@acme.test", [CHILD_POSITION_COLUMN]: 1 },
      { name: "c3", parent_id: id, parent_document: "Staffing Client", full_name: "Front Desk", job_title: null, email: null, is_primary: 0, [CHILD_POSITION_COLUMN]: 2 },
    ]);
  });

  await t.run(() => new Installer({ app_name: "staffing" }).install(true));

  await t.run(async () => {
    const client = await loopar.db.getRow("Staffing Client", "CLI-9001", ["customer", "payment_terms", "industry"]);
    assert.ok(client.customer, "client linked to a Customer");
    assert.equal(client.payment_terms, "Net 45", "staffing data kept");

    const customer = await loopar.db.getRow("Customer", client.customer, ["customer_name", "customer_type", "email", "phone", "address", "city", "state", "zip_code"]);
    assert.deepEqual({ ...customer }, {
      customer_name: "Acme Parking", customer_type: "Company", email: "ap@acme.test", phone: "555-0100",
      address: "1 Main St", city: "Atlanta", state: "GA", zip_code: "30301",
    });

    const people = await clients.clientContacts("CLI-9001");
    assert.deepEqual(people.map((p) => [p.full_name, p.email, p.job_title, p.is_primary]), [
      ["Jane Boss", "jane@acme.test", "CFO", 1],
      ["John Ops", "john@acme.test", "Ops", 0],
      ["Front Desk", null, null, 0],
    ]);
    assert.equal(people[0].user, "jane@acme.test", "old portal user linked to the contact");
    assert.equal((await clients.clientBillingContact("CLI-9001")).email, "jane@acme.test");

    for (const c of ["company_name", "email", "phone", "billing_address", "billing_city", "billing_state", "billing_zip_code"]) {
      assert.equal(await q().schema.hasColumn("Staffing Client", c), false, `${c} dropped`);
    }
    assert.equal(await q().schema.hasTable(OLD_CONTACT), false, "old child table dropped");
    assert.equal((await q()("Entity").select("name")).filter((e) => e.name === OLD_CONTACT).length, 0, "old meta removed");
    assert.equal((await q()("Permission").select("document")).filter((p) => p.document === OLD_CONTACT).length, 0, "old grants removed");
  });

  // Idempotent: a second update changes nothing.
  await t.run(() => new Installer({ app_name: "staffing" }).install(true));
  await t.run(async () => {
    assert.equal(await loopar.db.count("Customer", { customer_name: "Acme Parking" }), 1);
    assert.equal((await clients.clientContacts("CLI-9001")).length, 3);
  });
});

test("the client's title and select search follow the Customer name", async () => {
  await t.run(async () => {
    const doc = await loopar.newDocument("Staffing Client");
    assert.deepEqual(await doc.titlesFor(["CLI-9001"]), { "CLI-9001": "Acme Parking" });

    const found = await doc.getListToSelectElement("Parking");
    assert.deepEqual(found.title_fields, ["customer_name"]);
    assert.deepEqual(found.rows.map((r) => [r.name, r.customer_name]), [["CLI-9001", "Acme Parking"]]);
    assert.equal((await doc.getListToSelectElement("nothing-like-this")).rows.length, 0);

    const customer = (await loopar.db.getRow("Staffing Client", "CLI-9001", ["customer"])).customer;
    const twin = await loopar.newDocument("Staffing Client", { customer, status: "Prospect" });
    await assert.rejects(twin.save(), /already is Staffing Client CLI-9001/);
  });
});

test("an inquiry creates the client, its Customer and the sender as primary contact", async () => {
  await t.run(async () => {
    const name = await clients.createClient({
      customer: { customer_name: "Globex Fleet", email: "Sam@globex.test", phone: "555-0200" },
      contact: { full_name: "Sam Lee", job_title: "Fleet Manager", email: "Sam@globex.test", phone: "555-0200" },
      client: { status: "Prospect", notes: "From inquiry" },
    });
    assert.equal(await clients.findClientByCompany("Globex Fleet"), name);
    assert.equal(await clients.clientName(name), "Globex Fleet");

    const people = await clients.clientContacts(name);
    assert.deepEqual(people.map((p) => [p.full_name, p.email, p.job_title, p.is_primary]), [["Sam Lee", "sam@globex.test", "Fleet Manager", 1]]);
    const customer = await clients.clientCustomer(name, ["customer_type", "phone"]);
    assert.equal(customer.customer_type, "Company");
  });
});
