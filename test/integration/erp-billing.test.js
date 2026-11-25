import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loopar, applyTransition } from "loopar";
import { bootTestTenant } from "../support/tenant.js";

/*
 * AlfraERP billing: a Quote computes its totals from plain lines and
 * adjustments, freezes when it leaves Draft, and an approved quote is
 * invoiced (deposit, then the balance less the deposit). An Invoice is a
 * document of charge: payments move its balance and state.
 */

let t, customer;
const root = process.cwd();
const erp = (...p) => import(path.join(root, "apps", "erp", "modules", ...p));

before(async () => {
  t = await bootTestTenant({ apps: ["erp"] });
  await t.run(async () => {
    const { createCustomer } = await erp("crm", "customers.js");
    customer = await createCustomer({ customer_name: "Bella Company", email: "bella@co.test", city: "Lynn" });
    // No outgoing mail in tests.
    loopar.mail.send = async () => ({ ok: true });
  });
});
after(async () => { await t?.teardown(); });

const newQuote = async (extra = {}) => {
  const quote = await loopar.newDocument("Quote", {
    customer, title: "Hardwood refinishing",
    lines: [
      { section: "Living room", description: "Sand and refinish", quantity: 1000, unit: "sq ft", rate: 3.5 },
      { section: "Materials", description: "Stain and finish", quantity: 1, unit: "flat", rate: 200, tax_rate: 6.25 },
    ],
    adjustments: [{ label: "Volume tier (×0.95)", amount: -175 }],
    discount_percent: 0, deposit_percent: 50,
    ...extra,
  });
  await quote.save();
  // A saved instance stays "new": work on the stored record, like the desk does.
  return await loopar.getDocument("Quote", quote.name);
};

test("a quote numbers itself and computes its totals (tax per line rate)", async () => {
  await t.run(async () => {
    const quote = await newQuote();
    assert.match(quote.name, /^QTN-\d{6}-\d{4}$/);
    assert.equal(quote.status, "Draft");
    assert.equal(Number(quote.lines_subtotal), 3700);
    assert.equal(Number(quote.adjustments_total), -175);
    assert.equal(Number(quote.subtotal), 3525);
    assert.equal(Number(quote.tax_amount), 12.5);
    assert.equal(Number(quote.total), 3537.5);
    assert.equal(Number(quote.deposit_amount), 1768.75);

    const series = await newQuote({ series: "CQ" });
    assert.match(series.name, /^CQ-\d{6}-0001$/);
  });
});

test("a quote outside Draft can't be saved; it is invoiced deposit first, then the balance", async () => {
  await t.run(async () => {
    const quote = await newQuote();
    await assert.rejects(() => quote.makeInvoice("Deposit"), /approved/i);
    await applyTransition(quote, "Mark approved", {}, { system: true });
    assert.equal(quote.status, "Approved");

    const reloaded = await loopar.getDocument("Quote", quote.name);
    reloaded.title = "changed";
    await assert.rejects(() => reloaded.save(), /can no longer be edited/);

    const deposit = await quote.makeInvoice("Deposit");
    assert.match(deposit.name, /^INV-\d{6}-\d{4}$/);
    assert.equal(deposit.invoice_type, "Deposit");
    assert.equal(Number(deposit.total), 1768.75);
    assert.equal(deposit.status, "Draft");
    await assert.rejects(() => quote.makeInvoice("Deposit"), /already invoiced/);

    const balance = await quote.makeInvoice("Balance");
    assert.equal(Number(balance.total), round(3537.5 - 1768.75));
    await assert.rejects(() => quote.makeInvoice("Balance"), /fully invoiced/);
  });
});

const round = (v) => Math.round(v * 100) / 100;

test("an invoice is frozen once sent; payments move its balance and state", async () => {
  await t.run(async () => {
    const draft = await loopar.newDocument("Invoice", {
      customer, lines: [{ description: "Repair", quantity: 2, rate: 150 }], due_date: "2999-01-01",
    });
    await draft.save();
    const invoice = await loopar.getDocument("Invoice", draft.name);
    assert.equal(Number(invoice.total), 300);
    assert.equal(Number(invoice.balance), 300);
    await assert.rejects(() => invoice.recordPayment({ amount: 10 }), /issued invoice/);

    await invoice.send();
    assert.equal(invoice.status, "Sent");
    const frozen = await loopar.getDocument("Invoice", invoice.name);
    frozen.title = "changed";
    await assert.rejects(() => frozen.save(), /can no longer be edited/);

    await assert.rejects(() => invoice.recordPayment({ amount: 400 }), /more than the balance/);
    await invoice.recordPayment({ amount: 100, method: "Check", reference: "1042" });
    assert.equal(invoice.status, "Partially Paid");
    assert.equal(Number(invoice.balance), 200);
    await assert.rejects(() => invoice.cancel(), /with payments/);

    await invoice.recordPayment({ amount: 200, method: "Bank Transfer" });
    assert.equal(invoice.status, "Paid");
    assert.equal(Number(invoice.balance), 0);
    assert.ok(invoice.paid_at);
    const stored = await loopar.db.getRow("Invoice", invoice.name, ["status", "paid_amount"]);
    assert.deepEqual([stored.status, Number(stored.paid_amount)], ["Paid", 300]);
  });
});

test("an unpaid invoice past its due date is Overdue", async () => {
  await t.run(async () => {
    const draft = await loopar.newDocument("Invoice", { customer, lines: [{ description: "Visit", rate: 90 }], invoice_date: "2020-01-01", due_date: "2020-01-15" });
    await draft.save();
    const invoice = await loopar.getDocument("Invoice", draft.name);
    await invoice.send();
    assert.equal(invoice.status, "Overdue");
  });
});

test("a generated quote is written by its generator only while Draft", async () => {
  await t.run(async () => {
    const { writeGeneratedQuote } = await erp("billing", "quotes.js");
    const name = await writeGeneratedQuote({
      series: "GEN", generator: { document: "Signature Request", name: "x" }, customer, title: "Generated",
      lines: [{ description: "Work", quantity: 1, rate: 100, source_key: "a" }], deposit_percent: 50,
    });
    assert.match(name, /^GEN-/);
    await writeGeneratedQuote({ customer, lines: [{ description: "Work", quantity: 2, rate: 100 }] }, name);
    assert.equal(Number(await loopar.db.getValue("Quote", "total", name)), 200);

    const quote = await loopar.getDocument("Quote", name);
    assert.deepEqual(quote.lockedFields(), ["lines", "adjustments"]);
    await applyTransition(quote, "Mark approved", {}, { system: true });
    await assert.rejects(() => writeGeneratedQuote({ customer, lines: [] }, name), /cancel and amend it/);
  });
});

test("a generated invoice carries its service period and the customer's reference, and is written only while Draft", async () => {
  await t.run(async () => {
    const { writeGeneratedInvoice, generatedInvoices } = await erp("billing", "invoices.js");
    const generator = { document: "Signature Request", name: "run-1" };
    const name = await writeGeneratedInvoice({
      generator, customer, title: "Services, first week",
      customer_reference: "PO-4471", period_start: "2026-11-02", period_end: "2026-11-08",
      lines: [{ description: "Regular hours", quantity: 40, unit: "Hour", rate: 30, source_key: "week-1" }],
    });
    const invoice = await loopar.getDocument("Invoice", name);
    assert.equal(invoice.status, "Draft");
    assert.equal(invoice.generator_name, "run-1");
    assert.equal(invoice.customer_reference, "PO-4471");
    assert.equal(String(invoice.period_start).slice(0, 10), "2026-11-02");
    assert.equal(Number(invoice.total), 1200);

    // Rewritten while it is a draft: same invoice, new lines.
    await writeGeneratedInvoice({ generator, customer, lines: [{ description: "Regular hours", quantity: 38, unit: "Hour", rate: 30 }] }, name);
    assert.equal(Number(await loopar.db.getValue("Invoice", "total", name)), 1140);
    assert.deepEqual((await generatedInvoices(generator.document, generator.name)).map((i) => i.name), [name]);

    await assert.rejects(
      () => writeGeneratedInvoice({ generator, customer, period_start: "2026-11-08", period_end: "2026-11-02", lines: [{ description: "x", quantity: 1, rate: 1 }] }),
      /period ends before it starts/);

    await (await loopar.getDocument("Invoice", name)).issue();
    await assert.rejects(() => writeGeneratedInvoice({ generator, customer, lines: [] }, name), /can no longer be rewritten/);
  });
});

test("stored invoice print formats get the reference and the service period once", async () => {
  const { withReferenceAndPeriod } = await erp("billing", "print-upgrades.js");
  const old = [{ node: "ivc_1", element: "row", elements: [
    { node: "ivc_2", element: "doc_field", data: { field: "due_date" } },
    { node: "ivc_3", element: "doc_field", data: { field: "quote" } },
  ] }];
  const next = withReferenceAndPeriod(old);
  assert.deepEqual(next[0].elements.map((n) => n.data.field), ["due_date", "quote", "customer_reference", "period_start", "period_end"]);
  assert.equal(withReferenceAndPeriod(next), null);
});
