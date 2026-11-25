import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loopar, applyTransition } from "loopar";
import { bootTestTenant } from "../support/tenant.js";

/*
 * erp crm: a customer's places (Customer Address) and its contracts.
 * A Contract fills a Contract Template with the company, the customer and
 * itself, goes out for e-signature, and its terms freeze once sent. The
 * first contract a customer signs carries the sign-once templates.
 */

let t, customer, other, crm;
const root = process.cwd();
const erp = (...p) => import(path.join(root, "apps", "erp", "modules", ...p));
const q = () => loopar.db.qx();
const mailed = [];

const withWebsite = async (fn) => {
  const previous = loopar.webApp;
  loopar.webApp = { name: "site", menu_items: [{ page: "Document Signing", link: "sign" }] };
  try { return await fn(); } finally { loopar.webApp = previous; }
};
const contract = (name) => loopar.getDocument("Contract", name);
const send = (name) => withWebsite(async () => applyTransition(await contract(name), "Send for signature", {}, { system: true }));
const request = async (name) => loopar.getDocument("Signature Request", (await q()("Contract").where({ name }).first()).signature_request);

before(async () => {
  t = await bootTestTenant({ apps: ["erp"] });
  await t.run(async () => {
    crm = await erp("crm", "customers.js");
    customer = await crm.createCustomer({ customer_name: "Acme Rentals", email: "ap@acme.test", address: "1 Airport Rd", city: "Atlanta", state: "GA", zip_code: "30320" });
    other = await crm.createCustomer({ customer_name: "Other Co", email: "x@other.test" });

    const settings = await loopar.getDocument("Email Settings");
    Object.assign(settings, { host: "smtp.test", port: 465, secure: 1, from_name: "T", from_email: "t@loopar.test" });
    await settings.save();
    loopar.mail.getTransporter = async () => ({ sendMail: async (opts) => { mailed.push(opts); return { messageId: `m${mailed.length}` }; } });
    const sendLater = loopar.mail.sendLater.bind(loopar.mail);
    loopar.mail.sendLater = async (email) => { const queued = await sendLater(email); await queued.delivery; return queued; };

    for (const [name, kind, title, body, sign_once] of [
      ["MSA", "Master Agreement", "Master Services Agreement", "Between {{company.name}} ({{company.address}}) and {{customer.name}}.", 1],
      ["Schedule", "Rate Schedule", "Rate Schedule {{contract.name}}", "For {{contract.location}} from {{contract.valid_from}} to {{contract.valid_to}}. {{unknown.key}}", 0],
    ]) {
      const doc = await loopar.newDocument("Contract Template", { name, kind, document_title: title, body, active: 1, sign_once });
      doc.__KEEP_NAME__ = true;
      await doc.save();
    }
  });
});
after(async () => { await t?.teardown(); });

test("a customer address takes only the customer's own contacts, and its title is what selects show", async () => {
  await t.run(async () => {
    const { createAddress, addressRow, addressLine } = await erp("crm", "addresses.js");
    const stranger = await loopar.newDocument("Customer Contact", { full_name: "Not Ours", email: "no@else.test" });
    await stranger.save();
    await assert.rejects(createAddress({ customer, title: "Depot", contact: stranger.name }), /not a contact of customer/);

    const [{ contact }] = await (await erp("crm", "portal-access.js")).customerContacts(customer);
    const name = await createAddress({ customer, title: "  ATL Rental Car Center ", address: "2 Rental Car Dr", city: "Atlanta", state: "GA", zip_code: "30337", contact });
    assert.match(name, /^ADDR-/);
    const row = await addressRow(name);
    assert.equal(row.title, "ATL Rental Car Center");
    assert.equal(row.address_type, "Service Location");
    assert.equal(addressLine(row), "2 Rental Car Dr, Atlanta, GA 30337");
  });
});

test("a contract is numbered, checks its dates and location, and goes out with the master agreement first", async () => {
  await t.run(async () => {
    const { createAddress } = await erp("crm", "addresses.js");
    const place = (await q()("Customer Address").where({ customer }).first()).name;
    const foreign = await createAddress({ customer: other, title: "Elsewhere" });

    const bad = await loopar.newDocument("Contract", { title: "Bad", customer, valid_from: "2026-12-01", valid_to: "2026-11-01" });
    await assert.rejects(bad.save(), /Valid to/);
    const wrong = await loopar.newDocument("Contract", { title: "Wrong", customer, address: foreign, valid_from: "2026-12-01" });
    await assert.rejects(wrong.save(), /belongs to another customer/);

    const doc = await loopar.newDocument("Contract", { title: "Acme rates", customer, address: place, template: "Schedule", valid_from: "2026-12-01" });
    await doc.save();
    assert.match(doc.name, /^CTR-\d{6}-0001$/);
    assert.equal(doc.status, "Draft");

    // The company is a party of the contract: no name and address, nothing is sent.
    await assert.rejects(send(doc.name), /company name and address/);
    const company = await loopar.getDocument("Company");
    Object.assign(company, { company_name: "Primstone", address: "10 Peachtree St", city: "Atlanta", state: "GA", postal_code: "30303", email: "ops@primstone.test" });
    await company.save();

    await send(doc.name);
    const sent = await contract(doc.name);
    assert.equal(sent.status, "Pending Signature");
    assert.equal(sent.base_templates, "MSA", "first contract of the customer carries the sign-once template");
    assert.equal(sent.signer_email, "ap@acme.test", "the primary contact signs by default");

    const req = await request(doc.name);
    assert.match(req.title, /^Master Services Agreement \+ Rate Schedule CTR-/);
    assert.match(req.content_html, /Between Primstone \(10 Peachtree St, Atlanta, GA 30303\) and Acme Rentals\./);
    assert.match(req.content_html, /For ATL Rental Car Center from 2026-12-01 to until terminated\./);
    assert.match(req.content_html, /\{\{unknown\.key\}\}/, "unknown placeholders stay visible");

    // Sent: the terms are frozen, the notes are not.
    Object.assign(sent, { title: "Changed", valid_from: "2027-01-01", notes: "Called the client." });
    await sent.save();
    const row = await q()("Contract").where({ name: doc.name }).first();
    assert.deepEqual([row.title, String(row.valid_from).slice(0, 10), row.notes], ["Acme rates", "2026-12-01", "Called the client."]);

    await withWebsite(() => req.sign({ signed_name: "Jane Boss", agree: true }));
    const signed = await q()("Contract").where({ name: doc.name }).first();
    assert.equal(signed.status, "Active");
    assert.ok(signed.signed_at);
  });
});

test("the next contract of a customer that signed the master goes alone; a decline takes it back to Draft", async () => {
  await t.run(async () => {
    const doc = await loopar.newDocument("Contract", { title: "Acme rates 2027", customer, template: "Schedule", valid_from: "2027-01-01", signer_name: "Jim Ops", signer_email: "jim@acme.test" });
    await doc.save();
    await send(doc.name);
    assert.ok(!(await contract(doc.name)).base_templates, "a customer that signed it does not get it again");
    const req = await request(doc.name);
    assert.match(req.title, /^Rate Schedule CTR-/);
    assert.match(req.content_html, /For All locations from 2027-01-01/);

    await withWebsite(() => req.decline({ reason: "Rates too high" }));
    const back = await q()("Contract").where({ name: doc.name }).first();
    assert.equal(back.status, "Draft");
    assert.match(back.notes, /declined by Jim Ops: Rates too high/);

    // Cancelling a pending signature revokes its link.
    await send(doc.name);
    const pending = await request(doc.name);
    await applyTransition(await contract(doc.name), "Cancel signature");
    assert.equal(await loopar.db.getValue("Signature Request", "status", pending.name), "Revoked");
    assert.equal(await loopar.db.getValue("Contract", "status", doc.name), "Draft");
  });
});

test("activating without a signature, superseding and terminating follow the workflow", async () => {
  await t.run(async () => {
    // A manager's moves: only the ERP Manager role (or model code) runs them.
    const wf = await loopar.db.getRow("Workflow", "Contract", ["id"]);
    const narrowed = await q()("Workflow Transition").where({ parent_document: "Workflow", parent_id: wf.id }).whereIn("action", ["Activate", "Supersede", "Terminate", "Expire"]);
    assert.equal(narrowed.length, 4);
    assert.deepEqual([...new Set(narrowed.map((t) => t.allowed_roles))], ["ERP Manager"]);
    assert.ok(!(await q()("Workflow Transition").where({ parent_document: "Workflow", parent_id: wf.id, action: "Revise" }).first()), "an active contract is not reopened");

    const doc = await loopar.newDocument("Contract", { title: "Paper contract", customer: other, valid_from: "2026-12-01" });
    await doc.save();
    await assert.rejects(send(doc.name), /template/);
    await applyTransition(await contract(doc.name), "Activate", {}, { system: true });
    const active = await q()("Contract").where({ name: doc.name }).first();
    assert.deepEqual([active.status, active.__document_status__], ["Active", 8], "activating submits it");

    // Submitted: only the notes change; it is never deleted.
    const signed = await contract(doc.name);
    Object.assign(signed, { title: "Changed", notes: "Filed on paper." });
    await signed.save();
    assert.deepEqual(Object.values(await q()("Contract").where({ name: doc.name }).first("title", "notes")), ["Paper contract", "Filed on paper."]);
    await assert.rejects((await contract(doc.name)).delete(), /submitted|Submitted/);

    // Superseded: it stays as the contract that applied; the new version is a Draft to change.
    const { navigate } = await applyTransition(await contract(doc.name), "Supersede", {}, { system: true });
    const v1 = `${doc.name}-1`;
    assert.match(navigate, new RegExp(encodeURIComponent(v1)));
    const old = await q()("Contract").where({ name: doc.name }).first();
    assert.deepEqual([old.status, old.__document_status__, old.title], ["Superseded", 8, "Paper contract"]);
    const v1Row = await q()("Contract").where({ name: v1 }).first();
    assert.deepEqual([v1Row.status, v1Row.supersedes, v1Row.title, v1Row.signed_at || null, v1Row.__document_status__], ["Draft", doc.name, "Paper contract", null, 3]);
    const draft = await contract(v1);
    draft.title = "Paper contract v2";
    await draft.save();
    await applyTransition(await contract(v1), "Activate", {}, { system: true });
    await applyTransition(await contract(v1), "Supersede", {}, { system: true });
    assert.equal(await loopar.db.getValue("Contract", "supersedes", `${doc.name}-2`), v1, "versions count on");
    await applyTransition(await contract(`${doc.name}-2`), "Activate", {}, { system: true });
    await applyTransition(await contract(`${doc.name}-2`), "Terminate", {}, { system: true });
    const row = await q()("Contract").where({ name: `${doc.name}-2` }).first();
    assert.deepEqual([row.status, row.title], ["Terminated", "Paper contract v2"]);
  });
});
