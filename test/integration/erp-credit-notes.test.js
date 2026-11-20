import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loopar } from "loopar";
import { bootTestTenant } from "../support/tenant.js";

/*
 * Credit notes: given for an issued invoice, they post the reverse of the
 * sale, bring returned goods back at the cost they left with, and stay as
 * the customer's credit until refunded. A POS return is a credit note plus
 * its refund, from the register.
 */

let t, cn, pos, ledger, sl, se, fiscal, customer, profile;
const root = process.cwd();
const erp = (...p) => import(path.join(root, "apps", "erp", "modules", ...p));
const q = () => loopar.db.qx();
const MAIN = "Main Warehouse";
const round = (v) => Math.round(v * 100) / 100;
const bal = async (account, party = null) => (await ledger.balances({ accounts: [account], party }))[account] || 0;

before(async () => {
  t = await bootTestTenant({ apps: ["erp"] });
  cn = await erp("billing", "credit-notes.js");
  pos = await erp("sales", "pos.js");
  ledger = await erp("accounting", "ledger.js");
  sl = await erp("stock", "stock-ledger.js");
  se = await erp("stock", "stock-entries.js");
  fiscal = await erp("billing", "fiscal.js");
  fiscal.useFiscalProvider(null);
  await t.run(async () => {
    loopar.mail.send = async () => ({ ok: true });
    const { createCustomer } = await erp("crm", "customers.js");
    customer = await createCustomer({ customer_name: "Returns Co", email: "r@co.test" });
    await (await loopar.newDocument("Tax Template", { name: "VAT 15", tax_name: "VAT", rate: 15 })).save();
    for (const i of [
      { name: "LAMP", item_name: "Lamp", item_type: "Product", rate: 100, track_stock: 1, tax_template: "VAT 15" },
      { name: "SETUP", item_name: "Setup", item_type: "Service", rate: 50, tax_template: "VAT 15" },
    ]) { const d = await loopar.newDocument("Item", i); d.__KEEP_NAME__ = true; await d.save(); }
    const supplier = (await (async () => { const s = await loopar.newDocument("Supplier", { supplier_name: "Lamps Inc" }); await s.save(); return s.name; })());
    const r = await loopar.newDocument("Stock Entry", { entry_type: "Receipt", supplier, lines: [{ item: "LAMP", qty: 10, unit_cost: 40 }] });
    await r.save();
    await se.postStockEntry(await loopar.getDocument("Stock Entry", r.name));
    profile = await pos.ensurePosProfile();
  });
});
after(async () => { fiscal?.useFiscalProvider(undefined); await t?.teardown(); });

const issued = async (lines, extra = {}) => {
  const inv = await loopar.newDocument("Invoice", { customer, lines, ...extra });
  await inv.save();
  const doc = await loopar.getDocument("Invoice", inv.name);
  await doc.issue();
  return doc;
};

let invoice, note;
test("a credit note gives back part of an invoice: stock at its cost, the sale reversed, credit for the customer", async () => {
  await t.run(async () => {
    // 3 lamps (300) + setup (50) = 350 + 15% = 402.50
    invoice = await issued([{ item: "LAMP", quantity: 3 }, { item: "SETUP", quantity: 1 }]);
    assert.equal(Number(invoice.total), 402.5);
    const receivable = await bal("1300 Accounts Receivable", customer);

    const name = await cn.makeCreditNote(invoice.name, { reason: "One lamp broken", lines: [{ against_line: (await invoice.lines)[0].name, quantity: 1 }] });
    note = await loopar.getDocument("Invoice", name);
    assert.match(note.name, /^CN-/);
    assert.deepEqual([note.invoice_type, note.return_against, note.customer, Number(note.total)], ["Credit Note", invoice.name, customer, 115]);
    await note.issue();
    assert.equal(note.status, "Open");
    assert.equal(Number(note.balance), 115);

    assert.equal(round(await bal("1300 Accounts Receivable", customer) - receivable), -115);
    assert.deepEqual(await sl.balanceOf("LAMP", MAIN), { qty: 8, value: 320, rate: 40 }, "back at the 40 it left with");
    const original = await loopar.getDocument("Invoice", invoice.name);
    assert.deepEqual([Number(original.credited_amount), Number(original.balance), original.status], [115, 402.5, "Sent"], "the invoice's balance is untouched");
  });
});

test("nothing is credited twice, and never more than the invoice", async () => {
  await t.run(async () => {
    const lampLine = (await invoice.lines)[0].name;
    await assert.rejects(() => cn.makeCreditNote(invoice.name, { lines: [{ against_line: lampLine, quantity: 0 }] }), /already credited/);
    const draft = await loopar.getDocument("Invoice", await cn.makeCreditNote(invoice.name));
    const rows = await draft.lines;
    assert.deepEqual(rows.map((l) => Number(l.quantity)), [2, 1], "what is left: 2 lamps and the setup");
    draft.lines = rows.map((l) => ({ ...l, quantity: l.item === "LAMP" ? 5 : l.quantity }));
    await draft.save();
    await assert.rejects(() => draft.issue(), /more than the 2 left to credit/);
    await draft.cancel();
    await assert.rejects(() => cn.makeCreditNote(note.name), /not credited again/);
  });
});

test("a refund pays the credit back: the credit note is Applied", async () => {
  await t.run(async () => {
    const cash = await bal("1100 Cash");
    const refund = await note.recordPayment({ amount: 115, method: "Cash" });
    assert.equal(refund.payment_type, "Refund");
    assert.deepEqual([note.status, Number(note.balance)], ["Applied", 0]);
    assert.equal(round(await bal("1100 Cash") - cash), -115);
    await assert.rejects(() => note.cancel({ reason: "x" }), /refunded or applied cannot be cancelled/);
    await assert.rejects(async () => (await loopar.getDocument("Invoice", invoice.name)).cancel({ reason: "x" }), /has credit notes/);
  });
});

test("cancelling a credit note takes the stock back out and the credit away", async () => {
  await t.run(async () => {
    const other = await loopar.getDocument("Invoice", await cn.makeCreditNote(invoice.name, { reason: "Setup not done", lines: [{ against_line: (await invoice.lines)[1].name, quantity: 1 }] }));
    await other.issue();
    assert.equal(Number((await loopar.getDocument("Invoice", invoice.name)).credited_amount), 172.5);
    await other.cancel({ reason: "Setup was done" });
    assert.equal(Number((await loopar.getDocument("Invoice", invoice.name)).credited_amount), 115);
    assert.equal((await sl.balanceOf("LAMP", MAIN)).qty, 8);
  });
});

test("a POS return gives a credit note for the sale and refunds it from the register", async () => {
  await t.run(async () => {
    const shift = await pos.openShift({ pos_profile: profile, opening_cash: 100 });
    const sale = await pos.checkout({ lines: [{ item: "LAMP", quantity: 2 }], payments: [{ payment_method: "Cash", amount: 230 }] });
    assert.equal((await sl.balanceOf("LAMP", MAIN)).qty, 6);

    const ret = await loopar.getDocument("Sale", await pos.makeReturn(sale.name, { lines: [{ item: "LAMP", quantity: 1 }], reason: "Wrong color" }));
    assert.match(ret.name, /^RET-/);
    assert.equal(Number(ret.total), 115);
    ret.payments = [{ payment_method: "Cash", amount: 100 }];
    await ret.save();
    await assert.rejects(() => pos.completeSale(ret), /must be the total of the return/);
    ret.payments = [{ payment_method: "Cash", amount: 115 }];
    await ret.save();
    await pos.completeSale(await loopar.getDocument("Sale", ret.name));
    const done = await loopar.getDocument("Sale", ret.name);
    assert.equal(done.status, "Paid");
    const credit = await loopar.getDocument("Invoice", done.invoice);
    assert.deepEqual([credit.invoice_type, credit.return_against, credit.status], ["Credit Note", sale.invoice, "Applied"]);
    assert.equal((await sl.balanceOf("LAMP", MAIN)).qty, 7);

    const more = await loopar.getDocument("Sale", await pos.makeReturn(sale.name));
    assert.equal(Number((await more.lines)[0].quantity), 1, "only what is left");
    more.lines = (await more.lines).map((l) => ({ ...l, quantity: 5 }));
    more.payments = [{ payment_method: "Cash", amount: 575 }];
    await more.save();
    await assert.rejects(async () => pos.completeSale(await loopar.getDocument("Sale", more.name)), /left to return/);
    await pos.cancelSale(await loopar.getDocument("Sale", more.name));
    const totals = await pos.shiftTotals(shift.name);
    assert.deepEqual([totals.sales_total, totals.cash_expected], [115, 215], "230 sold − 115 returned; 100 + 115 in the drawer");
    await assert.rejects(async () => pos.cancelSale(await loopar.getDocument("Sale", sale.name), { reason: "x" }), /has returns/);
  });
});

test("a credit note's credit pays another invoice, and can be taken back", async () => {
  const payments = await erp("billing", "payments.js");
  await t.run(async () => {
    const next = await issued([{ item: "SETUP", quantity: 2 }]); // 115
    const credit = await loopar.getDocument("Invoice", await cn.makeCreditNote(invoice.name, { reason: "Discount agreed", lines: [{ against_line: (await invoice.lines)[1].name, quantity: 1 }] }));
    await credit.issue(); // 57.50 for the setup
    assert.equal(credit.document_title, "Credit Note");
    const receivable = await bal("1300 Accounts Receivable", customer);
    const credits = await payments.customerCredits(customer);
    assert.ok(credits.some((c) => c.kind === "Credit Note" && c.source === credit.name && c.available === 57.5));

    await payments.applyCredit({ source: credit.name, invoice: next.name, amount: 57.5 });
    assert.deepEqual(Object.values(await loopar.db.getRow("Invoice", next.name, ["status", "balance"])).map(String), ["Partially Paid", "57.5"]);
    assert.equal(await loopar.db.getValue("Invoice", "status", credit.name), "Applied");
    assert.equal(await bal("1300 Accounts Receivable", customer), receivable, "matching credit and debt posts nothing");

    await payments.unapplyCredit({ invoice: next.name, credit_note: credit.name });
    assert.equal(Number(await loopar.db.getValue("Invoice", "balance", next.name)), 115);
    assert.equal(await loopar.db.getValue("Invoice", "status", credit.name), "Open");
  });
});

test("an advance pays a later invoice: advances move to the receivable", async () => {
  const payments = await erp("billing", "payments.js");
  await t.run(async () => {
    const p = await loopar.newDocument("Payment", { customer, payment_method: "Cash", amount: 200 });
    await p.save();
    await payments.postPayment(await loopar.getDocument("Payment", p.name));
    assert.equal(await bal("2300 Customer Advances", customer), -200);
    const inv = await issued([{ item: "SETUP", quantity: 1 }]); // 57.50

    await payments.applyCredit({ source: p.name, invoice: inv.name, amount: 57.5 });
    assert.equal(await loopar.db.getValue("Invoice", "status", inv.name), "Paid");
    assert.equal(Number(await loopar.db.getValue("Payment", "unallocated_amount", p.name)), 142.5);
    assert.equal(await bal("2300 Customer Advances", customer), -142.5);
    await assert.rejects(() => payments.applyCredit({ source: p.name, invoice: inv.name, amount: 1 }), /not open/);

    await payments.cancelPayment(await loopar.getDocument("Payment", p.name), { reason: "Bounced" });
    assert.equal(Number(await loopar.db.getValue("Invoice", "balance", inv.name)), 57.5);
    assert.equal(await bal("2300 Customer Advances", customer), 0);
  });
});

test("the POS returns a sale it finds, and refunds it at once", async () => {
  await t.run(async () => {
    const sale = await pos.checkout({ lines: [{ item: "LAMP", quantity: 1 }], payments: [{ payment_method: "Cash", amount: 115 }] });
    const found = await pos.returnableSales({ search: sale.name });
    assert.deepEqual(found.map((s) => [s.name, s.left[0].quantity]), [[sale.name, 1]]);
    const ret = await pos.returnFromPos({ sale: sale.name, lines: [{ item: "LAMP", quantity: 1 }], payment_method: "Cash", reason: "Changed mind" });
    assert.deepEqual([ret.status, Number(ret.total)], ["Paid", 115]);
    assert.deepEqual(await pos.returnableSales({ search: sale.name }), [], "nothing left to return");
  });
});
