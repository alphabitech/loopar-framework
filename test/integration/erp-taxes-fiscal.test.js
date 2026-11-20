import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loopar } from "loopar";
import { bootTestTenant } from "../support/tenant.js";

/*
 * AlfraERP: items and tax templates price quote/invoice lines (one tax rate
 * per line, one `taxes` row per rate), and issuing an invoice runs the
 * localization app's fiscal provider inside one transaction — a failure
 * leaves no number used and the invoice still a draft.
 */

let t, fiscal, customer, mails = [];
const root = process.cwd();
const erp = (...p) => import(path.join(root, "apps", "erp", "modules", ...p));
const q = () => loopar.db.qx();

before(async () => {
  t = await bootTestTenant({ apps: ["erp"] });
  fiscal = await erp("billing", "fiscal.js");
  await t.run(async () => {
    const { createCustomer } = await erp("crm", "customers.js");
    customer = await createCustomer({ customer_name: "Gimnasio Uno", email: "uno@gym.test" });
    await loopar.db.setValue("Customer", "tax_id", "08011999123456", customer);
    loopar.mail.send = async (m) => { mails.push(m); return { ok: true }; };
    for (const [name, tax_name, rate, is_default] of [["Standard 15%", "Tax", 15, 1], ["Higher 18%", "Tax", 18, 0], ["Exempt", "Exempt", 0, 0]]) {
      const tt = await loopar.newDocument("Tax Template", { name, tax_name, rate, is_default });
      await tt.save();
    }
    for (const [name, item_name, rate, tax_template, item_type] of [["SUP-001", "Proteína 2lb", 100, "Standard 15%", "Product"], ["SVC-001", "Entrenamiento", 40, "", "Service"], ["CNT", "Fiscal counter", 0, "Exempt", "Service"]]) {
      const it = await loopar.newDocument("Item", { name, item_name, rate, tax_template, item_type });
      await it.save();
    }
  });
});
after(async () => { fiscal?.useFiscalProvider(undefined); await t?.teardown(); });

const newInvoice = async (lines) => {
  const inv = await loopar.newDocument("Invoice", { customer, title: "Mostrador", lines });
  await inv.save();
  return await loopar.getDocument("Invoice", inv.name);
};

test("an item without a tax template gets the default one", async () => {
  await t.run(async () => {
    assert.equal(await loopar.db.getValue("Item", "tax_template", "SVC-001"), "Standard 15%");
  });
});

test("lines take description, price and tax from their item; taxes break down per rate", async () => {
  await t.run(async () => {
    const inv = await newInvoice([
      { item: "SUP-001", quantity: 2 },
      { description: "Bebida importada", quantity: 1, rate: 50, tax_template: "Higher 18%" },
      { description: "Libro", quantity: 1, rate: 10, tax_template: "Exempt" },
    ]);
    const lines = await q()("Billing Line").where({ parent_document: "Invoice" }).whereIn("parent_id", q()("Invoice").select("id").where({ name: inv.name })).orderBy("id");
    assert.equal(lines[0].description, "Proteína 2lb");
    assert.equal(Number(lines[0].rate), 100);
    assert.equal(Number(lines[0].tax_rate), 15);
    assert.equal(Number(lines[0].tax_amount), 30);

    const taxes = await q()("Billing Tax").where({ parent_document: "Invoice" }).whereIn("parent_id", q()("Invoice").select("id").where({ name: inv.name })).orderBy("rate");
    assert.deepEqual(taxes.map((x) => [x.label, Number(x.rate), Number(x.base), Number(x.amount)]),
      [["Exempt", 0, 10, 0], ["Tax", 15, 200, 30], ["Tax", 18, 50, 9]]);
    assert.equal(Number(inv.subtotal), 260);
    assert.equal(Number(inv.tax_amount), 39);
    assert.equal(Number(inv.total), 299);
  });
});

/** A provider that keeps its counter in the database (like an authorized range). */
const provider = ({ failAfterReserve = false, invalid = false } = {}) => ({
  name: "Test",
  async validate(invoice, { customer: c }) {
    if (invalid) loopar.throw("No active fiscal range.");
    if (!c?.tax_id) loopar.throw("Tax ID required.");
  },
  async issue() {
    const next = Number(await loopar.db.getValue("Item", "cost", "CNT")) + 1;
    await q()("Item").where({ name: "CNT" }).update({ cost: next });
    if (failAfterReserve) throw new Error("printer offline");
    return { fiscal_number: `000-001-01-${String(next).padStart(8, "0")}`, fiscal_authorization: "AUTH-TEST", fiscal_series: "1 to 100", fiscal_deadline: "2027-12-31", data: { words: "x" } };
  },
  async void(invoice) { await q()("Item").where({ name: "CNT" }).update({ description: `voided ${invoice.fiscal_number}` }); },
});
const counter = () => t.run(async () => Number(await loopar.db.getValue("Item", "cost", "CNT")));

test("issuing runs the fiscal provider: number, authorization and the customer's tax id", async () => {
  fiscal.useFiscalProvider(provider());
  await t.run(async () => {
    const inv = await newInvoice([{ item: "SVC-001" }]);
    await inv.issue();
    const row = await loopar.db.getRow("Invoice", inv.name, ["status", "fiscal_number", "fiscal_authorization", "customer_tax_id", "issued_at"]);
    assert.equal(row.status, "Sent");
    assert.equal(row.fiscal_number, "000-001-01-00000001");
    assert.equal(row.fiscal_authorization, "AUTH-TEST");
    assert.equal(row.customer_tax_id, "08011999123456");
    assert.ok(row.issued_at);
    await assert.rejects(() => inv.issue(), /already issued/);
  });
  assert.equal(await counter(), 1);
});

test("a provider failure after reserving rolls the number back and leaves a draft", async () => {
  await t.run(async () => {
    const inv = await newInvoice([{ item: "SVC-001" }]);
    fiscal.useFiscalProvider(provider({ failAfterReserve: true }));
    await assert.rejects(() => inv.issue(), /printer offline/);
    assert.equal(inv.status, "Draft", "the instance is a draft again");
    assert.ok(!inv.fiscal_number, "no number on the instance");
    const row = await loopar.db.getRow("Invoice", inv.name, ["status", "fiscal_number"]);
    assert.deepEqual([row.status, row.fiscal_number], ["Draft", null]);

    fiscal.useFiscalProvider(provider({ invalid: true }));
    await assert.rejects(() => inv.issue(), /No active fiscal range/);
  });
  assert.equal(await counter(), 1, "no number was used");

  fiscal.useFiscalProvider(provider());
  await t.run(async () => {
    const inv = (await loopar.db.getAll("Invoice", ["name"], { status: "Draft" })).at(-1);
    const doc = await loopar.getDocument("Invoice", inv.name);
    await doc.send();
    assert.equal(doc.fiscal_number, "000-001-01-00000002", "the next number, no gap");
    assert.match(mails.at(-1).subject, /^Invoice 000-001-01-00000002/);
  });
});

test("staff can't set fiscal fields on a draft; a voided fiscal invoice keeps its number", async () => {
  fiscal.useFiscalProvider(provider());
  await t.run(async () => {
    const inv = await loopar.newDocument("Invoice", { customer, lines: [{ item: "SVC-001" }], fiscal_number: "FORGED", customer_tax_id: "X" });
    await inv.save();
    assert.equal(await loopar.db.getValue("Invoice", "fiscal_number", inv.name), null);

    const doc = await loopar.getDocument("Invoice", inv.name);
    await doc.issue();
    const number = doc.fiscal_number;
    await doc.cancel({ reason: "Error en el cliente" });
    const row = await loopar.db.getRow("Invoice", inv.name, ["status", "fiscal_number"]);
    assert.deepEqual([row.status, row.fiscal_number], ["Cancelled", number]);
    assert.equal(await loopar.db.getValue("Item", "description", "CNT"), `voided ${number}`);
  });
});

test("without a localization app an invoice is issued without a fiscal number", async () => {
  fiscal.useFiscalProvider(null);
  await t.run(async () => {
    const inv = await newInvoice([{ item: "SVC-001" }]);
    await inv.issue();
    const row = await loopar.db.getRow("Invoice", inv.name, ["status", "fiscal_number"]);
    assert.deepEqual([row.status, row.fiscal_number], ["Sent", null]);
  });
});

test("1.2.0 migration: a document's tax % moves to its taxable lines and tax rows are computed", async () => {
  await t.run(async () => {
    const quote = await loopar.newDocument("Quote", { customer, lines: [{ description: "Labor", rate: 1000 }, { description: "Materials", rate: 200 }], deposit_percent: 0 });
    await quote.save();
    // The quote as 1.1.0 stored it: a document rate and a taxable flag, no tax rows.
    const id = (await q()("Quote").where({ name: quote.name }).first("id")).id;
    if (!(await q().schema.hasColumn("Quote", "tax_percent"))) await q().schema.alterTable("Quote", (tb) => tb.decimal("tax_percent"));
    if (!(await q().schema.hasColumn("Billing Line", "taxable"))) await q().schema.alterTable("Billing Line", (tb) => tb.integer("taxable"));
    await q()("Quote").where({ id }).update({ tax_percent: 6.25 });
    await q()("Billing Line").where({ parent_id: id, parent_document: "Quote", description: "Materials" }).update({ taxable: 1, tax_rate: null });
    await q()("Billing Tax").where({ parent_id: id, parent_document: "Quote" }).delete();

    const { default: Installer } = await import(path.join(root, "apps", "erp", "installer.js"));
    await new Installer({ app_name: "erp" }).install();

    const lines = await q()("Billing Line").where({ parent_id: id, parent_document: "Quote" }).orderBy("id");
    assert.deepEqual(lines.map((l) => [l.description, Number(l.tax_rate) || 0]), [["Labor", 0], ["Materials", 6.25]]);
    const taxes = await q()("Billing Tax").where({ parent_id: id, parent_document: "Quote" });
    assert.deepEqual(taxes.map((x) => [Number(x.rate), Number(x.base), Number(x.amount)]), [[6.25, 200, 12.5]]);
  });
});

test("a new invoice starts with no lines (never another record's child rows)", async () => {
  await t.run(async () => {
    const fresh = await loopar.newDocument("Invoice");
    const raw = await fresh.rawValues();
    assert.deepEqual(raw.lines ?? [], []);
    assert.deepEqual(raw.taxes ?? [], []);
  });
});

test("a failed email after issuing keeps the invoice issued and says so; re-sending reports the failure", async () => {
  fiscal.useFiscalProvider(null);
  await t.run(async () => {
    const send = loopar.mail.send;
    loopar.mail.send = async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:587"); };
    try {
      const inv = await newInvoice([{ item: "SVC-001" }]);
      const result = await inv.send();
      assert.deepEqual([result.emailed, /ECONNREFUSED/.test(result.error)], [false, true]);
      assert.equal(await loopar.db.getValue("Invoice", "status", inv.name), "Sent");
      await assert.rejects(() => inv.send(), /could not be sent/);
    } finally {
      loopar.mail.send = send;
    }
  });
});

test("a tax included in the price keeps the price: the tax is what it holds, discounts included", async () => {
  const ledger = await erp("accounting", "ledger.js");
  await t.run(async () => {
    const tt = await loopar.newDocument("Tax Template", { name: "Retail 15% incl.", tax_name: "Tax", rate: 15, included_in_price: 1 });
    await tt.save();
    const it = await loopar.newDocument("Item", { name: "DRINK", item_name: "Drink", rate: 23, tax_template: "Retail 15% incl.", item_type: "Product" });
    await it.save();

    // 3 × 23 = 69 paid; base 60 + tax 9.
    const inv = await newInvoice([{ item: "DRINK", quantity: 3 }]);
    assert.deepEqual([Number(inv.subtotal), Number(inv.tax_amount), Number(inv.total)], [60, 9, 69]);
    const [line] = await q()("Billing Line").where({ parent_document: "Invoice" }).whereIn("parent_id", q()("Invoice").select("id").where({ name: inv.name }));
    assert.deepEqual([Number(line.tax_included), Number(line.net_amount), Number(line.tax_amount)], [1, 60, 9]);

    // Mixed with a tax added on top, and a 10% discount: 115 incl. → 103.50 paid; 40 + 15% on 36.
    const mixed = await loopar.newDocument("Invoice", { customer, discount_percent: 10, lines: [{ item: "DRINK", quantity: 5 }, { item: "SVC-001", quantity: 1 }] });
    await mixed.save();
    const doc = await loopar.getDocument("Invoice", mixed.name);
    // DRINK: 115 → 103.50 = 90 + 13.50; SVC: 40 → 36 + 5.40
    assert.deepEqual([Number(doc.total), Number(doc.tax_amount)], [round(103.5 + 36 + 5.4), round(13.5 + 5.4)]);
    const taxes = await q()("Billing Tax").where({ parent_document: "Invoice", parent_id: q()("Invoice").select("id").where({ name: doc.name }).first() });
    assert.deepEqual(taxes.map((r) => [Number(r.base), Number(r.amount)]).sort((a, b) => a[0] - b[0]), [[36, 5.4], [90, 13.5]]);

    await doc.issue();
    const [entry] = await ledger.entriesOf("Invoice", doc.name);
    const lines = await q()("Journal Entry Line").where({ parent_document: "Journal Entry", parent_id: q()("Journal Entry").select("id").where({ name: entry.name }).first() });
    const debit = lines.reduce((a, l) => a + Number(l.debit), 0);
    const credit = lines.reduce((a, l) => a + Number(l.credit), 0);
    assert.equal(round(debit), round(credit));
    assert.equal(round(debit), 144.9);
  });
});

const round = (v) => Math.round(v * 100) / 100;
