import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loopar } from "loopar";
import { bootTestTenant } from "../support/tenant.js";

/*
 * Payment terms: invoices and bills get a schedule of installments from
 * their terms (or the party's); payments settle them in order, an unpaid
 * installment past its date makes the document overdue, and the aging
 * reports age each installment by its own date.
 */

let t, pt, payments, bills, reports, customer, supplier;
const root = process.cwd();
const erp = (...p) => import(path.join(root, "apps", "erp", "modules", ...p));
const day = (offset) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);
const schedule = async (doc) => (await doc.payment_schedule).map((r) => [String(r.due_date).slice(0, 10), Number(r.amount), Number(r.paid_amount), Number(r.outstanding)]);

before(async () => {
  t = await bootTestTenant({ apps: ["erp"] });
  pt = await erp("billing", "payment-terms.js");
  payments = await erp("billing", "payments.js");
  bills = await erp("purchasing", "bills.js");
  reports = await erp("accounting", "reports.js");
  (await erp("billing", "fiscal.js")).useFiscalProvider(null);
  await t.run(async () => {
    loopar.mail.send = async () => ({ ok: true });
    const { createCustomer } = await erp("crm", "customers.js");
    customer = await createCustomer({ customer_name: "Terms Co", email: "terms@co.test" });
    const s = await loopar.newDocument("Supplier", { supplier_name: "Terms Supplier", payment_terms: "Net 30" }); await s.save(); supplier = s.name;
    const it = await loopar.newDocument("Item", { name: "WORK", item_name: "Work", item_type: "Service", rate: 100 }); it.__KEEP_NAME__ = true; await it.save();
  });
});
after(async () => { await t?.teardown(); });

test("due dates follow the basis of each term", () => {
  assert.equal(pt.termDueDate("2026-01-20", { due_basis: "Days after the invoice date", credit: 15 }), "2026-02-04");
  assert.equal(pt.termDueDate("2026-01-20", { due_basis: "Days after the end of the invoice month", credit: 10 }), "2026-02-10");
  assert.equal(pt.termDueDate("2026-01-20", { due_basis: "Months after the end of the invoice month", credit: 1 }), "2026-02-28");
});

test("installing creates common terms; a template's portions add up to 100%", async () => {
  await t.run(async () => {
    assert.ok(await loopar.db.count("Payment Terms Template", "50% Now, 50% in 30 Days"));
    const bad = await loopar.newDocument("Payment Terms Template", { name: "Bad", terms: [{ invoice_portion: 60, due_basis: "Days after the invoice date", credit: 0 }] });
    bad.__KEEP_NAME__ = true;
    await assert.rejects(() => bad.save(), /add up to 100%/);
  });
});

let invoiceName;
test("an invoice with terms gets its installments; payments settle them in order and the last unpaid one past its date is overdue", async () => {
  await t.run(async () => {
    const tpl = await loopar.newDocument("Payment Terms Template", { name: "Thirds", terms: [
      { description: "First", invoice_portion: 33.33, due_basis: "Days after the invoice date", credit: 0 },
      { description: "Second", invoice_portion: 33.33, due_basis: "Days after the invoice date", credit: 10 },
      { description: "Third", invoice_portion: 33.34, due_basis: "Days after the invoice date", credit: 20 },
    ] });
    tpl.__KEEP_NAME__ = true;
    await tpl.save();
    const inv = await loopar.newDocument("Invoice", { customer, invoice_date: day(-15), payment_terms: "Thirds", lines: [{ item: "WORK", quantity: 1 }] });
    await inv.save();
    let doc = await loopar.getDocument("Invoice", inv.name);
    invoiceName = doc.name;
    assert.equal(String(doc.due_date).slice(0, 10), day(5));
    assert.deepEqual(await schedule(doc), [[day(-15), 33.33, 0, 33.33], [day(-5), 33.33, 0, 33.33], [day(5), 33.34, 0, 33.34]]);
    await doc.issue();
    doc = await loopar.getDocument("Invoice", inv.name);
    assert.equal(doc.status, "Overdue", "the first installments are past their dates");

    await payments.receiveForInvoice(doc, { amount: 50, payment_date: day(0), method: "Cash" });
    doc = await loopar.getDocument("Invoice", inv.name);
    assert.deepEqual(await schedule(doc), [[day(-15), 33.33, 33.33, 0], [day(-5), 33.33, 16.67, 16.66], [day(5), 33.34, 0, 33.34]]);
    assert.equal(doc.status, "Overdue");
    await payments.receiveForInvoice(doc, { amount: 16.66, payment_date: day(0), method: "Cash" });
    doc = await loopar.getDocument("Invoice", inv.name);
    assert.equal(doc.status, "Partially Paid", "what is left is not due yet");
  });
});

test("the aging report ages each installment by its own due date", async () => {
  await t.run(async () => {
    const inv = await loopar.newDocument("Invoice", { customer, invoice_date: day(-40), payment_terms: "50% Now, 50% in 30 Days", lines: [{ item: "WORK", quantity: 2 }] });
    await inv.save();
    await (await loopar.getDocument("Invoice", inv.name)).issue();
    const row = (await reports.receivablesAging()).rows.find((r) => r.party === customer);
    // 100 late 40 days, 100 late 10 days, and 33.34 of the first invoice not due yet.
    assert.deepEqual([row.current, row.d1_30, row.d31_60, row.total], [33.34, 100, 100, 233.34]);
    assert.equal(row.documents.filter((d) => d.name === inv.name).length, 2);
  });
});

test("a hand-typed schedule must add up to the total; a bill takes the supplier's terms", async () => {
  await t.run(async () => {
    const bad = await loopar.newDocument("Invoice", { customer, lines: [{ item: "WORK", quantity: 1 }], payment_schedule: [{ due_date: day(10), amount: 60 }] });
    await assert.rejects(() => bad.save(), /must add up to the total/);
    const ok = await loopar.newDocument("Invoice", { customer, lines: [{ item: "WORK", quantity: 1 }], payment_schedule: [{ due_date: day(10), amount: 60 }, { due_date: day(40), amount: 40 }] });
    await ok.save();
    const doc = await loopar.getDocument("Invoice", ok.name);
    assert.equal(String(doc.due_date).slice(0, 10), day(40));
    assert.deepEqual((await doc.payment_schedule).map((r) => Number(r.invoice_portion)), [60, 40]);

    const b = await loopar.newDocument("Purchase Invoice", { supplier, bill_date: day(0), lines: [{ description: "Rent", quantity: 1, rate: 500 }] });
    await b.save();
    const bill = await loopar.getDocument("Purchase Invoice", b.name);
    assert.deepEqual([bill.payment_terms, String(bill.due_date).slice(0, 10)], ["Net 30", day(30)]);
    await bills.postBill(bill);
    const posted = await loopar.getDocument("Purchase Invoice", b.name);
    assert.deepEqual(await schedule(posted), [[day(30), 500, 0, 500]]);
    assert.equal(posted.status, "Unpaid");
  });
});

test("the invoice print format shows the terms and the schedule (added once to stored formats)", async () => {
  await t.run(async () => {
    const q = () => loopar.db.qx();
    const read = async () => (await q()("Print Format Builder").where({ name: "Invoice Customer" }).first("doc_structure")).doc_structure;
    const nodes = JSON.stringify(JSON.parse(await read()));
    assert.ok(nodes.includes('"field":"payment_schedule"') && nodes.includes('"field":"payment_terms"'));
    // A format stored before: gets them once.
    const without = JSON.parse(await read()).filter((n) => n.data?.field !== "payment_schedule");
    await q()("Print Format Builder").where({ name: "Invoice Customer" }).update({ doc_structure: JSON.stringify(without) });
    await pt.schedulePrintFormats(["Invoice Customer"]);
    await pt.schedulePrintFormats(["Invoice Customer"]);
    assert.equal(JSON.parse(await read()).filter((n) => n.data?.field === "payment_schedule").length, 1);
  });
});
