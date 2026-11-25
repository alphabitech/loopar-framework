import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loopar } from "loopar";
import { bootTestTenant } from "../support/tenant.js";

/*
 * Payments: money received from a customer, applied to its invoices —
 * posted to the ledger (cash/bank against receivable, the rest as an
 * advance), invoices paid in the same transaction, undone by cancelling.
 */

let t, ledger, pay, fiscal, customer, other;
const root = process.cwd();
const erp = (...p) => import(path.join(root, "apps", "erp", "modules", ...p));
const q = () => loopar.db.qx();

before(async () => {
  t = await bootTestTenant({ apps: ["erp"] });
  ledger = await erp("accounting", "ledger.js");
  pay = await erp("billing", "payments.js");
  fiscal = await erp("billing", "fiscal.js");
  fiscal.useFiscalProvider(null);
  await t.run(async () => {
    loopar.mail.send = async () => ({ ok: true });
    const { createCustomer } = await erp("crm", "customers.js");
    customer = await createCustomer({ customer_name: "Payer Co", email: "payer@co.test" });
    other = await createCustomer({ customer_name: "Other Co", email: "other@co.test" });
  });
});
after(async () => { fiscal?.useFiscalProvider(undefined); await t?.teardown(); });

const issued = async (rate, cust = customer, due = "2999-01-01") => {
  const inv = await loopar.newDocument("Invoice", { customer: cust, due_date: due, lines: [{ description: "Work", rate }] });
  await inv.save();
  const doc = await loopar.getDocument("Invoice", inv.name);
  await doc.issue();
  return doc.name;
};
const invoiceRow = (name) => loopar.db.getRow("Invoice", name, ["status", "paid_amount", "balance"]);
const newPayment = async (values) => {
  const p = await loopar.newDocument("Payment", { customer, payment_method: "Bank Transfer", ...values });
  await p.save();
  return await loopar.getDocument("Payment", p.name);
};

test("default payment methods point at cash and bank", async () => {
  await t.run(async () => {
    assert.equal(await loopar.db.getValue("Payment Method", "account", "Cash"), "1100 Cash");
    assert.equal(await loopar.db.getValue("Payment Method", "account", "Bank Transfer"), "1200 Bank");
  });
});

let A, B, paymentName;
test("one payment pays two invoices oldest first; the rest stays as an advance", async () => {
  await t.run(async () => {
    A = await issued(100);
    B = await issued(300);
    const suggested = await pay.suggestAllocations(customer, 450);
    assert.deepEqual(suggested.map((s) => [s.invoice, s.allocated_amount]), [[A, 100], [B, 300]]);

    const p = await newPayment({ amount: 450, reference: "TX-1", allocations: suggested });
    assert.deepEqual([p.status, Number(p.allocated_amount), Number(p.unallocated_amount)], ["Draft", 400, 50]);
    await pay.postPayment(p);
    paymentName = p.name;

    assert.deepEqual(Object.values(await invoiceRow(A)).map(String), ["Paid", "100", "0"]);
    assert.deepEqual(Object.values(await invoiceRow(B)).map(String), ["Paid", "300", "0"]);
    const rows = await q()("Invoice Payment").where({ payment: p.name });
    assert.equal(rows.length, 2, "each invoice shows the payment");

    const bal = await ledger.balances({ party: customer });
    assert.equal(bal["1300 Accounts Receivable"], 0);
    assert.equal(bal["2300 Customer Advances"], -50);
    assert.equal((await ledger.balances({ accounts: ["1200 Bank"] }))["1200 Bank"], 450);
  });
});

test("a posted payment is read only; cancelling reverses it and the invoices owe again", async () => {
  await t.run(async () => {
    const p = await loopar.getDocument("Payment", paymentName);
    p.reference = "changed";
    await assert.rejects(() => p.save(), /cancel it to undo it/);

    const doc = await loopar.getDocument("Payment", paymentName);
    await pay.cancelPayment(doc, { reason: "Bounced" });
    assert.equal(await loopar.db.getValue("Payment", "status", paymentName), "Cancelled");
    assert.deepEqual(Object.values(await invoiceRow(A)).map(String), ["Sent", "0", "100"]);
    assert.equal((await q()("Invoice Payment").where({ payment: paymentName })).length, 0);
    const bal = await ledger.balances({ party: customer });
    assert.equal(bal["1300 Accounts Receivable"], 400);
    assert.equal(bal["2300 Customer Advances"] || 0, 0);
  });
});

test("payments only apply to the customer's issued invoices, within their balance", async () => {
  await t.run(async () => {
    const theirs = await issued(80, other);
    await assert.rejects(() => newPayment({ amount: 80, allocations: [{ invoice: theirs, allocated_amount: 80 }] }), /another customer/);
    await assert.rejects(() => newPayment({ amount: 50, allocations: [{ invoice: A, allocated_amount: 60 }] }), /applies .* but is/);

    const p = await newPayment({ amount: 500, allocations: [{ invoice: B, allocated_amount: 350 }] });
    await assert.rejects(() => pay.postPayment(p), /more than the balance/);
    assert.equal(await loopar.db.getValue("Payment", "status", p.name), "Draft", "nothing posted");
    assert.equal((await ledger.entriesOf("Payment", p.name)).length, 0);
  });
});

test("Record payment on an invoice creates and posts a Payment", async () => {
  await t.run(async () => {
    const inv = await loopar.getDocument("Invoice", A);
    const payment = await inv.recordPayment({ amount: 60, method: "Cash", reference: "R-1" });
    assert.equal(await loopar.db.getValue("Payment", "status", payment.name), "Posted");
    assert.deepEqual([inv.status, Number(inv.balance)], ["Partially Paid", 40]);
    assert.equal((await ledger.balances({ accounts: ["1100 Cash"] }))["1100 Cash"], 60);
    await assert.rejects(() => inv.cancel(), /with payments/);
  });
});

test("invoice and payment are submittable: issued and posted are Submitted, cancelled ones are kept and amended", async () => {
  await t.run(async () => {
    const st = async (entity, name) => Number((await q()(entity).where({ name }).first("__document_status__")).__document_status__);
    const inv = await issued(200);
    assert.equal(await st("Invoice", inv), 8, "issuing submits the invoice");

    // Posted after the invoice was submitted: its Payments tab (allow on submit) still takes the rows.
    const p = await newPayment({ amount: 200, allocations: [{ invoice: inv, allocated_amount: 200 }] });
    assert.equal(await st("Payment", p.name), 3);
    await pay.postPayment(p);
    assert.equal(await st("Payment", p.name), 8, "posting submits the payment");
    assert.equal((await q()("Invoice Payment").where({ payment: p.name })).length, 1);

    // Submitted records are never deleted, nor changed behind the model.
    await assert.rejects(() => loopar.getDocument("Payment", p.name).then((d) => d.delete()), /Submitted: it can't be deleted/);
    await assert.rejects(() => loopar.db.setValue("Invoice", "customer", other, inv), /Submitted/);

    // Cancel runs the payment's own undo first (its rows on the invoice point to it), then marks it.
    const doc = await loopar.getDocument("Payment", p.name);
    await pay.cancelPayment(doc, { reason: "Wrong amount" });
    assert.equal(await st("Payment", p.name), 9);
    assert.equal((await q()("Invoice Payment").where({ payment: p.name })).length, 0);
    await assert.rejects(() => loopar.getDocument("Payment", p.name).then((d) => d.delete()), /Cancelled: it is kept/);

    // Amend: a new Draft with its own number that remembers the cancelled one.
    const { name: copy } = await (await loopar.getDocument("Payment", p.name)).amend();
    const row = await q()("Payment").where({ name: copy }).first();
    assert.notEqual(copy, p.name);
    assert.deepEqual([row.status, Number(row.__document_status__), row.__amended_from__, row.cancel_reason || null], ["Draft", 3, p.name, null]);
    await assert.rejects(() => loopar.getDocument("Payment", p.name).then((d) => d.submit()), /runs "Submit" from its own actions|only a Draft/);

    // The invoice: cancelled (no payments left), then amended into a new Draft.
    const issuedInv = await loopar.getDocument("Invoice", inv);
    await issuedInv.cancel({ reason: "Re-bill" });
    assert.deepEqual([await loopar.db.getValue("Invoice", "status", inv), await st("Invoice", inv)], ["Cancelled", 9]);
    const { name: again } = await (await loopar.getDocument("Invoice", inv)).amend();
    const draft = await q()("Invoice").where({ name: again }).first();
    assert.deepEqual([draft.status, Number(draft.__document_status__), draft.__amended_from__], ["Draft", 3, inv]);
  });
});

test("updating turns old invoice payment rows into posted Payments", async () => {
  await t.run(async () => {
    const C = await issued(70);
    const id = (await q()("Invoice").where({ name: C }).first("id")).id;
    // A row as 1.3 recorded it: no Payment behind it.
    await q()("Invoice Payment").insert({ name: loopar.getUniqueKey(), parent_id: id, parent_document: "Invoice", payment_date: "2026-11-01", amount: 70, method: "Zelle", reference: "Z-9" });
    await q()("Invoice").where({ id }).update({ paid_amount: 70, balance: 0, status: "Paid" });

    const { default: Installer } = await import(path.join(root, "apps", "erp", "installer.js"));
    await new Installer({ app_name: "erp" }).install();

    const row = await q()("Invoice Payment").where({ parent_id: id, parent_document: "Invoice" }).first();
    assert.ok(row.payment, "linked to its Payment");
    const p = await loopar.db.getRow("Payment", row.payment, ["status", "amount", "payment_method", "customer"]);
    assert.deepEqual([p.status, Number(p.amount), p.payment_method, p.customer], ["Posted", 70, "Zelle", customer]);
    assert.equal((await ledger.entriesOf("Payment", row.payment)).length, 1);
  });
});
