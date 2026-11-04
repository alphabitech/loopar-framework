import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  loopar, PermissionManager, SCOPE,
  portalIdentity, customerCondition, isCustomerRecord,
} from "loopar";
import { bootTestTenant } from "../support/tenant.js";

/**
 * Portal identity (User → Customer Contact → Customer) and the 'customer'
 * scope: a portal user reaches only the records of their own customers,
 * never another customer's — the cross-app leak the core CRM closes.
 */
let t;
let crm;
before(async () => {
  t = await bootTestTenant();
  crm = await import(path.join(process.cwd(), "apps", "loopar", "modules", "crm", "portal-access.js"));
});
after(async () => { await t?.teardown(); });

const newCustomer = async (customer_name, email) => {
  const doc = await loopar.newDocument("Customer");
  doc.customer_name = customer_name;
  doc.email = email;
  await doc.save();
  return doc.name;
};

let seq = 0;
const grant = (relation_name, document, action, scope) =>
  loopar.db.insertRow("Permission", {
    name: `cs-${relation_name}-${document}-${action}-${++seq}`,
    relation: "User", relation_name, document, action, scope, deny: 0, app: "loopar",
  });

let A, B, userA, userB, contactA;

test("contacts of two customers get their own portal users", async () => {
  await t.run(async () => {
    A = await newCustomer("Acme", "ana@acme.test");
    B = await newCustomer("Globex", "bob@globex.test");
    assert.match(A, /^CUST-/);

    contactA = await crm.ensureCustomerContact(A, { email: "ana@acme.test", full_name: "Ana" });
    const contactB = await crm.ensureCustomerContact(B, { email: "bob@globex.test", full_name: "Bob" });
    assert.equal(await crm.ensureCustomerContact(A, { email: "ANA@acme.test" }), contactA, "idempotent by email");

    const a = await crm.grantPortalAccess(contactA);
    const b = await crm.grantPortalAccess(contactB, { password: "unknown" });
    assert.equal(a.created, true);
    assert.ok(a.password, "temporary password is returned once");
    assert.equal(b.password, null);
    userA = a.user;
    userB = b.user;

    const again = await crm.grantPortalAccess(contactA);
    assert.deepEqual([again.user, again.created, again.password], [userA, false, null]);

    const primary = await crm.customerContacts(A);
    assert.equal(primary.length, 1);
    assert.equal(String(primary[0].is_primary), "1");
  });
});

test("identity resolves only the user's own customers", async () => {
  await t.run(async () => {
    const idA = await portalIdentity(userA);
    const idB = await portalIdentity(userB);
    assert.deepEqual([...idA.customers], [A]);
    assert.deepEqual([...idB.customers], [B]);
    assert.equal(idA.contact, contactA);

    const nobody = await portalIdentity("not-a-user");
    assert.deepEqual([nobody.contact, nobody.customers.length], [null, 0]);
  });
});

test("customerCondition / isCustomerRecord never cross customers", async () => {
  await t.run(async () => {
    const idA = await portalIdentity(userA);
    const rows = await loopar.db.getAll("Customer", ["name"], customerCondition("Customer", idA));
    assert.deepEqual(rows.map((r) => r.name), [A]);

    assert.equal(await isCustomerRecord("Customer", A, idA), true);
    assert.equal(await isCustomerRecord("Customer", B, idA), false);
    assert.equal(await isCustomerRecord("Customer", "CUST-missing", idA), null);
    assert.equal(await isCustomerRecord("Customer Contact", contactA, idA), true);

    const none = await portalIdentity("not-a-user");
    assert.deepEqual(await loopar.db.getAll("Customer", ["name"], customerCondition("Customer", none)), []);
  });
});

test("a contact of two customers sees both", async () => {
  await t.run(async () => {
    await crm.ensureCustomerContact(B, { email: "ana@acme.test" });
    const id = await portalIdentity(userA);
    assert.deepEqual([...id.customers].sort(), [A, B].sort());
  });
});

test("the portal user of a contact is not writable from a form save", async () => {
  await t.run(async () => {
    const doc = await loopar.getDocument("Customer Contact", contactA);
    doc.user = userB;
    doc.notes = "edited";
    await doc.save();
    const row = await loopar.db.getRow("Customer Contact", contactA, ["user", "notes"]);
    assert.deepEqual([row.user, row.notes], [userA, "edited"]);
  });
});

test("a user linked to one contact can't be given to another", async () => {
  await t.run(async () => {
    const other = await crm.ensureCustomerContact(B, { email: "other@globex.test", full_name: "Other" });
    await assert.rejects(() => crm.linkPortalUser(other, userA));
  });
});

test("scope 'customer' resolves and ranks between own and all", async () => {
  await t.run(async () => {
    await grant(userA, "Customer", "list", "customer");
    await grant(userA, "Customer", "update", "customer");
    await grant(userA, "Customer", "update", "own");
    await grant(userA, "Customer", "view", "customer");
    await grant(userA, "Customer", "view", "all");
    await PermissionManager.reload(userA);
    assert.equal(PermissionManager.scope("Customer", "list", userA), SCOPE.CUSTOMER);
    assert.equal(PermissionManager.scope("Customer", "update", userA), SCOPE.CUSTOMER);
    assert.equal(PermissionManager.scope("Customer", "view", userA), SCOPE.ALL);
    assert.equal(PermissionManager.getPermissions(userA).scopes["customer:list"], "customer");
  });
});

test("a customer-scoped request is refused on another customer's record", async () => {
  await t.run(async () => {
    const { BaseController } = await import("loopar");
    const request = (action, props = {}) => new BaseController({
      document: "Customer", action, method: "POST", body: {}, req: { __WORKSPACE_NAME__: "desk" }, ...props,
    });
    const asA = { name: userA };
    // userA is a contact of A and B (previous test); C belongs to somebody else.
    const C = await newCustomer("Initech", "ceo@initech.test");

    assert.equal(await request("update", { name: A }).isAuthorized(asA), true);
    await assert.rejects(() => request("update", { name: C }).isAuthorized(asA), /permission/i);

    await grant(userA, "Customer Contact", "update", "customer");
    await PermissionManager.reload(userA);
    const contact = new BaseController({ document: "Customer Contact", action: "update", method: "POST", name: contactA, body: {}, req: { __WORKSPACE_NAME__: "desk" } });
    assert.equal(await contact.isAuthorized(asA), true);

    const filter = await request("list").ownerFilters(userA);
    assert.deepEqual((await loopar.db.getAll("Customer", ["name"], filter)).map((r) => r.name).sort(), [A, B].sort());
  });
});

test("createCustomer / external ids", async () => {
  await t.run(async () => {
    const { createCustomer, setExternalId, externalId, customerByExternalId, customerRow } = await import(path.join(process.cwd(), "apps", "loopar", "modules", "crm", "customers.js"));
    const name = await createCustomer({ customer_name: "Dana Doe", email: "Dana@Doe.test", phone: "555", tax_id: "ignored" });
    const row = await customerRow(name, ["customer_name", "email", "phone"]);
    assert.deepEqual([row.customer_name, row.email, row.phone], ["Dana Doe", "dana@doe.test", "555"]);
    assert.equal((await crm.customerContacts(name)).length, 1);

    await setExternalId(name, "stripe", "cus_1");
    await setExternalId(name, "stripe", "cus_2");
    await setExternalId(name, "quickbooks", "qb_9");
    assert.equal(await externalId(name, "stripe"), "cus_2");
    assert.equal(await externalId(name, "quickbooks"), "qb_9");
    assert.equal(await customerByExternalId("stripe", "cus_2"), name);
    assert.equal(await customerByExternalId("stripe", "cus_1"), null);
    assert.equal((await crm.customerContacts(name)).length, 1, "contacts survive a Customer save");
  });
});

test("updating loopar migrates the old Customer.portal_user links (7.4.0)", async () => {
  await t.run(async () => {
    const q = () => loopar.db.qx();
    await q().schema.alterTable("Customer", (tb) => { tb.string("portal_user"); tb.string("portal_invited_at"); tb.string("stripe_customer_id"); });

    const web = await loopar.newDocument("User");
    Object.assign(web, { name: "legacy@cloud.test", email: "legacy@cloud.test", password: "Aa1!aaaaaaaa", confirm_password: "Aa1!aaaaaaaa", user_type: "Web", __document_status__: "Active" });
    await web.save({ validate: false });

    const id = await loopar.db.nextId("Customer");
    await q()("Customer").insert({ id, name: "legacy@cloud.test", customer_name: "", email: "legacy@cloud.test", status: "active", portal_user: "legacy@cloud.test", stripe_customer_id: "cus_legacy" });

    const { default: Installer } = await import(path.join(process.cwd(), "apps", "loopar", "installer.js"));
    await new Installer({ app_name: "loopar" }).install(true);

    const row = await loopar.db.getRow("Customer", "legacy@cloud.test", ["customer_name", "status"]);
    assert.deepEqual([row.customer_name, row.status], ["legacy@cloud.test", "Active"]);
    const identity = await portalIdentity("legacy@cloud.test");
    assert.deepEqual([...identity.customers], ["legacy@cloud.test"]);
    assert.equal(await q().schema.hasColumn("Customer", "portal_user"), false);
    assert.equal(await q().schema.hasColumn("Customer", "portal_invited_at"), false);
    assert.equal(await q().schema.hasColumn("Customer", "stripe_customer_id"), false);
    const { externalId, customerByExternalId } = await import(path.join(process.cwd(), "apps", "loopar", "modules", "crm", "customers.js"));
    assert.equal(await externalId("legacy@cloud.test", "stripe"), "cus_legacy");
    assert.equal(await customerByExternalId("STRIPE", "cus_legacy"), "legacy@cloud.test");
  });
});
