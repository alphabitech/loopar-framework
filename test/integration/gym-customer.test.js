import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loopar, portalIdentity } from "loopar";
import { bootTestTenant } from "../support/tenant.js";

/**
 * The gym app on the core Customer: a member keeps only a `customer` link
 * (name/phone/email live in Customer), portal access goes through the
 * customer's contact, and the update migrates the old member columns.
 */
let t;
let Installer;
let server;
let memberCard;
const root = process.cwd();

before(async () => {
  t = await bootTestTenant();
  ({ default: Installer } = await import(path.join(root, "apps", "gym", "installer.js")));
  await t.run(() => new Installer({ app_name: "gym" }).install());
  server = await import(path.join(root, "apps", "gym", "modules", "gym", "shared", "server.js"));
  ({ memberCard } = await import(path.join(root, "apps", "gym", "modules", "gym", "shared", "member-card.js")));
});
after(async () => { await t?.teardown(); });

let ana;

test("gym installs with Gym Member linked to Customer and no contact columns", async () => {
  await t.run(async () => {
    const schema = () => loopar.db.qx().schema;
    assert.ok(await schema().hasColumn("Gym Member", "customer"));
    for (const column of ["full_name", "phone", "email", "portal_user"]) {
      assert.equal(await schema().hasColumn("Gym Member", column), false, column);
    }
    const grants = await loopar.db.getAll("Permission", ["document", "action"], { relation: "Role", relation_name: "Gym User" });
    assert.ok(grants.some((g) => g.document === "Customer" && g.action === "search"), "staff can search customers");
  });
});

test("createMember creates the Customer (+ primary contact) and the card reads from it", async () => {
  await t.run(async () => {
    const doc = await server.createMember({ full_name: "  Ana   Martínez ", phone: "9876-1201", email: "Ana@Example.com", gender: "F" });
    ana = doc.name;
    const row = await loopar.db.getRow("Gym Member", ana, ["customer", "status"]);
    assert.match(row.customer, /^CUST-/);
    assert.equal(row.status, "Lead");

    const customer = await loopar.db.getRow("Customer", row.customer, ["customer_name", "phone", "email", "customer_type"]);
    assert.deepEqual({ ...customer }, { customer_name: "Ana Martínez", phone: "9876-1201", email: "ana@example.com", customer_type: "Individual" });

    const card = await memberCard(ana);
    assert.equal(card.member.full_name, "Ana Martínez");
    assert.equal(card.member.phone, "9876-1201");
    assert.equal(card.member.email, "ana@example.com");
    assert.equal(card.member.portal_user, null);

    const titles = await (await loopar.newDocument("Gym Member")).titlesFor([ana]);
    assert.equal(titles[ana], "Ana Martínez");
  });
});

test("one member per customer", async () => {
  await t.run(async () => {
    const customer = await loopar.db.getValue("Gym Member", "customer", ana);
    await assert.rejects(() => server.createMember({ customer }), /ya es socio/);
  });
});

test("portal access goes through the customer's contact and resolves the member", async () => {
  await t.run(async () => {
    const doc = await loopar.getDocument("Gym Member", ana);
    const { user, password } = await doc.createPortalUser();
    assert.equal(user, "ana@example.com");
    assert.ok(password, "temporary password shown once");

    const identity = await portalIdentity(user);
    const customer = await loopar.db.getValue("Gym Member", "customer", ana);
    assert.deepEqual([...identity.customers], [customer]);
    assert.equal((await memberCard(ana)).member.portal_user, user);

    const again = await (await loopar.getDocument("Gym Member", ana)).createPortalUser();
    assert.deepEqual(again, { user, password: null });
  });
});

test("front desk search finds members by their customer's name or phone", async () => {
  await t.run(async () => {
    for (const q of ["martínez", "1201", "ana@example"]) {
      const rows = await server.all("Gym Member", ["name"], await server.memberSearch(q));
      assert.deepEqual(rows.map((r) => r.name), [ana], q);
    }
  });
});

test("the update migrates legacy member columns into Customer and drops them", async () => {
  await t.run(async () => {
    const q = () => loopar.db.qx();
    // A tenant still on gym 1.0.x: the old columns and a member without customer.
    await q().schema.alterTable("Gym Member", (tb) => {
      tb.string("full_name"); tb.string("phone"); tb.string("email"); tb.string("portal_user");
    });
    const legacyUser = await loopar.newDocument("User");
    Object.assign(legacyUser, {
      name: "luis@example.com", email: "luis@example.com", first_name: "Luis", user_type: "Web",
      password: "Legacy-Pass-123!", confirm_password: "Legacy-Pass-123!", __document_status__: "Active",
    });
    await legacyUser.save({ validate: false });
    // `customer` is NOT NULL on a fresh table (on an updated tenant it is added
    // nullable); an empty value stands for "not linked yet".
    await q()("Gym Member").insert([
      { name: "MEM-90001", customer: "", status: "Active", full_name: "Luis Fernández", phone: "9876-1206", email: "Luis@Example.com", portal_user: "luis@example.com" },
      { name: "MEM-90002", customer: "", status: "Lead", full_name: "José Rodríguez", phone: "9876-1204", email: "not-an-email" },
    ]);

    await new Installer({ app_name: "gym" }).install(true);

    for (const column of ["full_name", "phone", "email", "portal_user"]) {
      assert.equal(await q().schema.hasColumn("Gym Member", column), false, `${column} dropped`);
    }
    const luis = await loopar.db.getRow("Gym Member", "MEM-90001", ["customer"]);
    const jose = await loopar.db.getRow("Gym Member", "MEM-90002", ["customer"]);
    const cl = await loopar.db.getRow("Customer", luis.customer, ["customer_name", "phone", "email"]);
    const cj = await loopar.db.getRow("Customer", jose.customer, ["customer_name", "phone", "email", "notes"]);
    assert.deepEqual({ ...cl }, { customer_name: "Luis Fernández", phone: "9876-1206", email: "luis@example.com" });
    assert.equal(cj.customer_name, "José Rodríguez");
    assert.equal(cj.email, null);
    assert.match(cj.notes, /not-an-email/);

    const identity = await portalIdentity("luis@example.com");
    assert.deepEqual([...identity.customers], [luis.customer], "old portal user linked through the contact");

    // Idempotent: a second update changes nothing.
    const customers = (await loopar.db.getAll("Customer", ["name"])).length;
    await new Installer({ app_name: "gym" }).install(true);
    assert.equal((await loopar.db.getAll("Customer", ["name"])).length, customers);
  });
});
