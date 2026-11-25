import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loopar, applyTransition, CHILD_POSITION_COLUMN } from "loopar";
import { bootTestTenant } from "../support/tenant.js";

/*
 * Staffing on the erp places and contracts: a Staffing Site links a
 * Customer Address of its client's Customer; a Rate Agreement keeps the
 * rates and is signed as an erp Contract (created with it), whose state and
 * validity decide whether the rates apply. Covers the 1.14.0 migration
 * (sites, agreements, MSA, templates and the company move to erp / core).
 */

const root = process.cwd();
const staffing = (...p) => import(path.join(root, "apps", "staffing", ...p));
const erp = (...p) => import(path.join(root, "apps", "erp", "modules", ...p));
const q = () => loopar.db.qx();

let t, Installer, clients, rates, addresses;
let client, customer, place, site;

const withWebsite = async (fn) => {
  const previous = loopar.webApp;
  loopar.webApp = { name: "site", menu_items: [{ page: "Document Signing", link: "sign" }] };
  try { return await fn(); } finally { loopar.webApp = previous; }
};
const contractOf = async (agreement) => (await q()("Staffing Rate Agreement").where({ name: agreement }).first()).contract;
const move = async (contract, action) => withWebsite(async () => applyTransition(await loopar.getDocument("Contract", contract), action, {}, { system: true }));

before(async () => {
  t = await bootTestTenant({ apps: ["erp"] });
  ({ default: Installer } = await staffing("installer.js"));
  await t.run(() => new Installer({ app_name: "staffing" }).install());
  clients = await staffing("modules", "staffing", "shared", "clients.js");
  rates = await staffing("modules", "staffing", "shared", "rates.js");
  addresses = await erp("crm", "addresses.js");

  await t.run(async () => {
    const settings = await loopar.getDocument("Email Settings");
    Object.assign(settings, { host: "smtp.test", port: 465, secure: 1, from_name: "T", from_email: "t@loopar.test" });
    await settings.save();
    loopar.mail.getTransporter = async () => ({ sendMail: async () => ({ messageId: "m" }) });
    const sendLater = loopar.mail.sendLater.bind(loopar.mail);
    loopar.mail.sendLater = async (email) => { const queued = await sendLater(email); await queued.delivery; return queued; };

    const company = await loopar.getDocument("Company");
    Object.assign(company, { company_name: "Primstone", address: "10 Peachtree St", city: "Atlanta", state: "GA", postal_code: "30303" });
    await company.save();
    for (const [name, kind, title, body] of [
      ["MSA", "Master Agreement", "Master Services Agreement", "{{company.name}} staffs {{customer.name}}."],
      ["Rates", "Rate Schedule", "Rate Schedule", "Rates of {{agreement.name}} at {{agreement.site}}:\n\n{{rates_table}}"],
    ]) {
      const doc = await loopar.newDocument("Contract Template", { name, kind, document_title: title, body, active: 1, sign_once: name === "MSA" ? 1 : 0 });
      doc.__KEEP_NAME__ = true;
      await doc.save();
    }

    client = await clients.createClient({ customer: { customer_name: "Acme Rentals", email: "ap@acme.test" }, client: { status: "Prospect" } });
    customer = await clients.clientCustomerName(client);
    place = await addresses.createAddress({ customer, title: "ATL Rental Car Center", address: "2 Rental Car Dr", city: "Atlanta", latitude: 33.6407, longitude: -84.4277, geofence_radius_m: 200, notes: "Badge at gate B" });
    const doc = await loopar.newDocument("Staffing Site", { customer_address: place, client, status: "Active" });
    await doc.save();
    site = doc.name;
    const job = await loopar.newDocument("Job Position", { name: "Porter", active: 1, default_pay_rate: 14 });
    job.__KEEP_NAME__ = true;
    await job.save();
    await (await loopar.newDocument("Staffing Position", { job_position: "Porter", default_bill_rate: 20 })).save();
  });
});
after(async () => { await t?.teardown(); });

test("a site is a place of its client's customer: its title is the location's, one site per location", async () => {
  await t.run(async () => {
    const { siteName, siteWithPlace } = await staffing("modules", "staffing", "shared", "sites.js");
    assert.equal(await siteName(site), "ATL Rental Car Center");
    const full = await siteWithPlace(site);
    assert.deepEqual([full.title, Number(full.latitude), Number(full.geofence_radius_m), full.address_line], ["ATL Rental Car Center", 33.6407, 200, "2 Rental Car Dr, Atlanta"]);

    const doc = await loopar.newDocument("Staffing Site");
    assert.deepEqual(await doc.titlesFor([site]), { [site]: "ATL Rental Car Center" });
    const found = await doc.getListToSelectElement("Rental Car");
    assert.deepEqual(found.rows.map((r) => [r.name, r.title]), [[site, "ATL Rental Car Center"]]);

    const twice = await loopar.newDocument("Staffing Site", { customer_address: place, client });
    await assert.rejects(twice.save(), /already is site/);
    const otherClient = await clients.createClient({ customer: { customer_name: "Other Co" } });
    const wrong = await loopar.newDocument("Staffing Site", { customer_address: place, client: otherClient });
    await assert.rejects(wrong.save(), /not an address of the client's customer/);
  });
});

test("a rate agreement opens its Draft contract; the rates apply once it is signed, frozen until revised", async () => {
  await t.run(async () => {
    const agreement = await loopar.newDocument("Staffing Rate Agreement", { client, site, lines: [{ position: "Porter", bill_rate: 30, pay_rate: 18 }] });
    agreement.contractDefaults = { title: "Acme airport rates", valid_from: "2026-11-01" };
    await agreement.save();

    const contract = await contractOf(agreement.name);
    const row = await q()("Contract").where({ name: contract }).first();
    assert.deepEqual([row.status, row.title, row.customer, row.address, row.template, String(row.valid_from).slice(0, 10), row.generator_document, row.generator_name],
      ["Draft", "Acme airport rates", customer, place, "Rates", "2026-11-01", "Staffing Rate Agreement", agreement.name]);
    assert.deepEqual(await (await loopar.newDocument("Staffing Rate Agreement")).titlesFor([agreement.name]), { [agreement.name]: "Acme airport rates" });

    // A Draft contract prices nothing: the position's default applies.
    assert.deepEqual(await rates.staffingRates({ location: place, position: "Porter", date: "2026-11-10" }), { agreement: null, bill_rate: 20, pay_rate: null, overtime_multiplier: null });

    await move(contract, "Send for signature");
    const request = await loopar.getDocument("Signature Request", (await q()("Contract").where({ name: contract }).first()).signature_request);
    assert.match(request.content_html, /Primstone staffs Acme Rentals\./, "the client's first contract carries the MSA");
    assert.match(request.content_html, new RegExp(`Rates of ${agreement.name} at ATL Rental Car Center`));
    assert.match(request.content_html, /Porter.*\$30\.00.*\$45\.00/s);
    await withWebsite(() => request.sign({ signed_name: "Jane Boss", agree: true }));

    assert.equal(await loopar.db.getValue("Contract", "status", contract), "Active");
    assert.equal(await loopar.db.getValue("Staffing Client", "status", client), "Active", "a signed contract activates the prospect");
    const priced = await rates.staffingRates({ location: place, position: "Porter", date: "2026-11-10" });
    assert.deepEqual([priced.agreement, priced.bill_rate, priced.pay_rate], [agreement.name, 30, 18]);
    assert.equal((await rates.staffingRates({ location: place, position: "Porter", date: "2026-10-31" })).agreement, null, "outside its validity");

    // Signed: the rates stay what the client signed.
    const signed = await loopar.getDocument("Staffing Rate Agreement", agreement.name);
    signed.lines = [{ position: "Porter", bill_rate: 99 }];
    await signed.save();
    assert.equal((await rates.staffingRates({ location: place, position: "Porter", date: "2026-11-10" })).bill_rate, 30);
    await assert.rejects(signed.delete(), /is Active/);

    // Superseded: the agreement follows the new version; the rates reopen and no longer apply until it is signed.
    await move(contract, "Supersede");
    const next = await contractOf(agreement.name);
    assert.equal(next, `${contract}-1`);
    assert.equal(await loopar.db.getValue("Contract", "status", contract), "Superseded");
    const draft = await loopar.getDocument("Staffing Rate Agreement", agreement.name);
    draft.lines = [{ position: "Porter", bill_rate: 32, pay_rate: 18 }];
    await draft.save();
    assert.equal((await rates.staffingRates({ location: place, position: "Porter", date: "2026-11-10" })).bill_rate, 20);
    await move(next, "Activate");
    assert.equal((await rates.staffingRates({ location: place, position: "Porter", date: "2026-11-10" })).bill_rate, 32);
  });
});

test("an agreement without rates can't send its contract; deleting it takes its Draft contract along", async () => {
  await t.run(async () => {
    const empty = await loopar.newDocument("Staffing Rate Agreement", { client });
    await empty.save();
    const contract = await contractOf(empty.name);
    assert.equal(await loopar.db.getValue("Contract", "address", contract), null, "client-wide");
    await assert.rejects(move(contract, "Activate"), /Add at least one rate/);
    await (await loopar.getDocument("Staffing Rate Agreement", empty.name)).delete();
    assert.ok((await q()("Contract").where({ name: contract }).first()).__deleted_at__, "its Draft contract is deleted too");
  });
});

test("the update moves sites, agreements, the MSA, the templates and the company out of staffing", async () => {
  await t.run(async () => {
    // What 1.13.x left: the old columns, the template table and the workflow.
    await q().schema.alterTable("Staffing Site", (tb) => {
      for (const c of ["site_name", "address", "city", "state", "zip_code", "site_contact", "access_notes"]) tb.string(c).nullable();
      tb.decimal("latitude", 10, 6).nullable(); tb.decimal("longitude", 10, 6).nullable(); tb.integer("geofence_radius_m").nullable();
    });
    await q().schema.alterTable("Staffing Rate Agreement", (tb) => {
      for (const c of ["title", "status", "signer_name", "signer_email", "signature_request"]) tb.string(c).nullable();
      tb.date("valid_from").nullable(); tb.date("valid_to").nullable(); tb.datetime("signed_at").nullable(); tb.integer("includes_msa").nullable();
    });
    await q().schema.alterTable("Staffing Client", (tb) => { tb.datetime("msa_signed_at").nullable(); tb.string("msa_signature").nullable(); });
    await q().schema.createTable("Staffing Contract Template", (tb) => {
      tb.increments("id"); tb.string("name"); tb.string("kind"); tb.integer("active"); tb.string("document_title"); tb.text("body");
    });

    // A Company with only its name: the old address fills the rest, the name stays.
    const company = await loopar.getDocument("Company");
    Object.assign(company, { address: "", phone: "", email: "" });
    await company.save();
    for (const [field, value] of Object.entries({ company_name: "Old Name", phone: "555-0100", email: "ops@pwl.test", company_address: "1 Old Rd, Atlanta GA" })) {
      await q()("Document Single Values").insert({ name: `Staffing Settings-${field}`, document: "Staffing Settings", field, value });
    }

    await q()("Staffing Contract Template").insert([
      { name: "PWL MSA", kind: "Master Services Agreement", active: 1, document_title: "MSA", body: "Between {{company.name}} and {{client.company_name}}, {{client.address}}." },
      { name: "PWL Rates", kind: "Rate Schedule", active: 1, document_title: "Rates {{agreement.title}}", body: "From {{agreement.valid_from}} to {{agreement.valid_to}} at {{agreement.site}}: {{rates_table}}" },
    ]);
    await q()("Contract Template").update({ active: 0 });

    const old = await clients.createClient({ customer: { customer_name: "Legacy Parking", email: "lp@legacy.test" }, client: { status: "Active" } });
    const oldCustomer = await clients.clientCustomerName(old);
    await q()("Staffing Client").where({ name: old }).update({ msa_signed_at: "2026-06-01 10:00:00", msa_signature: "SR-MSA" });
    await q()("Staffing Site").insert({ name: "SITE-9001", client: old, customer_address: "", status: "Active", geofence_radius_m: 150,
      site_name: "Legacy Deck", address: "5 Deck St", city: "Atlanta", state: "GA", zip_code: "30301", latitude: 33.75, longitude: -84.39,
      site_contact: "Bob 555-0199", access_notes: "Level 3" });
    await q()("Staffing Rate Agreement").insert({ name: "RATE-9001", client: old, site: "SITE-9001", contract: "", overtime_multiplier: 1.5,
      title: "Legacy rates", status: "Active", valid_from: "2026-06-01", signer_name: "Lee", signer_email: "lee@legacy.test",
      signature_request: "SR-OLD", signed_at: "2026-06-02 09:00:00", includes_msa: 0 });
    const { id } = await q()("Staffing Rate Agreement").where({ name: "RATE-9001" }).first("id");
    await q()("Staffing Rate Line").insert({ name: "RL-9001", parent_id: id, parent_document: "Staffing Rate Agreement", [CHILD_POSITION_COLUMN]: 0, position: "Porter", bill_rate: 25, pay_rate: 15, overtime_bill_rate: 37.5 });
    await loopar.db.insertRow("Signature Request", { name: "SR-OLD", document: "Staffing Rate Agreement", document_name: "RATE-9001", title: "old", status: "Signed" });
    await q()("Workflow").insert({ name: "Staffing Rate Agreement", document: "Staffing Rate Agreement", state_field: "status", app: "staffing", active: 1 });
  });

  await t.run(() => new Installer({ app_name: "staffing" }).install(true));

  await t.run(async () => {
    const has = (table, column) => q().schema.hasColumn(table, column);

    // Company: empty fields filled, the existing name kept.
    const company = await loopar.getDocument("Company");
    assert.deepEqual([company.company_name, company.address, company.phone, company.email], ["Primstone", "1 Old Rd, Atlanta GA", "555-0100", "ops@pwl.test"]);
    assert.equal(await q()("Document Single Values").where({ document: "Staffing Settings" }).whereIn("field", ["company_name", "phone", "email", "company_address"]).first(), undefined, "old settings values removed");

    // Site → Customer Address.
    const moved = await q()("Staffing Site").where({ name: "SITE-9001" }).first();
    const addr = await q()("Customer Address").where({ name: moved.customer_address }).first();
    assert.equal(Number(addr.geofence_radius_m), 150, "the site's geofence went to its location");
    assert.equal(await has("Staffing Site", "geofence_radius_m"), false);
    const oldCustomer = await clients.clientCustomerName(moved.client);
    assert.deepEqual([addr.title, addr.customer, addr.address, addr.zip_code, Number(addr.latitude), addr.address_type, addr.notes],
      ["Legacy Deck", oldCustomer, "5 Deck St", "30301", 33.75, "Service Location", "On-site contact: Bob 555-0199\nLevel 3"]);
    for (const c of ["site_name", "address", "latitude", "site_contact", "access_notes"]) assert.equal(await has("Staffing Site", c), false, `${c} dropped`);

    // Templates → Contract Templates, placeholders renamed.
    const msa = await q()("Contract Template").where({ name: "PWL MSA" }).first();
    assert.deepEqual([msa.kind, Number(msa.active), msa.body], ["Master Agreement", 1, "Between {{company.name}} and {{customer.name}}, {{customer.address}}."]);
    const schedule = await q()("Contract Template").where({ name: "PWL Rates" }).first();
    assert.equal(schedule.document_title, "Rates {{contract.title}}");
    assert.equal(schedule.body, "From {{contract.valid_from}} to {{contract.valid_to}} at {{agreement.site}}: {{rates_table}}");
    assert.equal(await q().schema.hasTable("Staffing Contract Template"), false);

    // Agreement → Contract, with its state, validity, signer and signature.
    const contractName = (await q()("Staffing Rate Agreement").where({ name: "RATE-9001" }).first()).contract;
    const contract = await q()("Contract").where({ name: contractName }).first();
    assert.deepEqual([contract.title, contract.status, contract.customer, contract.address, contract.template, String(contract.valid_from).slice(0, 10), contract.signer_email, contract.signature_request, contract.generator_name],
      ["Legacy rates", "Active", oldCustomer, moved.customer_address, "PWL Rates", "2026-06-01", "lee@legacy.test", "SR-OLD", "RATE-9001"]);
    assert.deepEqual(await q()("Signature Request").where({ name: "SR-OLD" }).first("document", "document_name"), { document: "Contract", document_name: contractName });
    assert.equal((await rates.staffingRates({ location: moved.customer_address, position: "Porter", date: "2026-11-10" })).bill_rate, 25, "its rates still apply");
    for (const c of ["title", "status", "valid_from", "signer_email", "includes_msa"]) assert.equal(await has("Staffing Rate Agreement", c), false, `${c} dropped`);

    // The MSA signed outside the agreement stays signed, so the next contract goes without it.
    const master = await q()("Contract").where({ customer: oldCustomer, title: "Master Services Agreement" }).first();
    assert.deepEqual([master.status, master.signature_request, master.template], ["Active", "SR-MSA", "PWL MSA"]);
    const { pendingBaseTemplates } = await erp("crm", "contracts.js");
    assert.deepEqual(await pendingBaseTemplates(oldCustomer), []);
    for (const c of ["msa_signed_at", "msa_signature"]) assert.equal(await has("Staffing Client", c), false, `${c} dropped`);

    assert.equal((await q()("Workflow").select("name")).filter((w) => w.name === "Staffing Rate Agreement").length, 0, "old workflow removed");
  });

  // Idempotent: a second update changes nothing.
  await t.run(() => new Installer({ app_name: "staffing" }).install(true));
  await t.run(async () => {
    assert.equal(await loopar.db.count("Customer Address", { title: "Legacy Deck" }), 1);
    assert.equal(await loopar.db.count("Contract", { generator_name: "RATE-9001" }), 1);
    assert.equal(await loopar.db.count("Contract", { title: "Master Services Agreement" }), 1);
  });
});
