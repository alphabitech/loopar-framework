import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loopar } from "loopar";
import { bootTestTenant } from "../support/tenant.js";

/*
 * Purchases: a receipt puts goods in stock against Stock Received Not
 * Billed; the supplier's bill clears it into Payable (a price that differs
 * goes to stock adjustments); a bill can bring its stock itself or be an
 * expense; supplier payments pay bills, the rest stays as an advance.
 */

let t, bills, se, sl, ledger, supplier;
const root = process.cwd();
const erp = (...p) => import(path.join(root, "apps", "erp", "modules", ...p));
const q = () => loopar.db.qx();
const MAIN = "Main Warehouse";
const BILL = "Purchase Invoice";
const bal = async (account) => (await ledger.balances({ accounts: [account] }))[account] || 0;

before(async () => {
  t = await bootTestTenant({ apps: ["erp"] });
  bills = await erp("purchasing", "bills.js");
  se = await erp("stock", "stock-entries.js");
  sl = await erp("stock", "stock-ledger.js");
  ledger = await erp("accounting", "ledger.js");
  await t.run(async () => {
    const s = await loopar.newDocument("Supplier", { supplier_name: "Paper Co" });
    await s.save();
    supplier = s.name;
    await (await loopar.newDocument("Tax Template", { name: "VAT 15", tax_name: "VAT", rate: 15 })).save();
    for (const i of [
      { name: "PAPER", item_name: "Paper box", item_type: "Product", rate: 30, cost: 20, track_stock: 1, tax_template: "VAT 15" },
      { name: "POWER", item_name: "Electricity", item_type: "Service", rate: 0, tax_template: "VAT 15" },
    ]) { const d = await loopar.newDocument("Item", i); d.__KEEP_NAME__ = true; await d.save(); }
  });
});
after(async () => { await t?.teardown(); });

const draftBill = async (values) => {
  const b = await loopar.newDocument(BILL, { supplier, ...values });
  await b.save();
  return await loopar.getDocument(BILL, b.name);
};

let receipt, bill;
test("a receipt's bill clears stock received not billed into payable; a different price is a stock adjustment", async () => {
  await t.run(async () => {
    const r = await loopar.newDocument("Stock Entry", { entry_type: "Receipt", supplier, supplier_invoice: "F-100", lines: [{ item: "PAPER", qty: 10, unit_cost: 20 }] });
    await r.save();
    receipt = await se.postStockEntry(await loopar.getDocument("Stock Entry", r.name));
    assert.equal(await bal("2150 Stock Received Not Billed"), -200);

    bill = await loopar.getDocument(BILL, await bills.makeBillFromReceipt(receipt.name));
    assert.equal(bill.supplier_invoice, "F-100");
    const [line] = await bill.lines;
    assert.deepEqual([line.item, Number(line.quantity), Number(line.rate), line.receipt], ["PAPER", 10, 20, receipt.name]);
    bill.lines = [{ ...line, rate: 21 }]; // the bill says 21
    await bill.save();
    await bills.postBill(bill);
    assert.equal(bill.status, "Unpaid");
    assert.equal(Number(bill.total), 241.5); // 210 + 15%
    assert.equal(await bal("2150 Stock Received Not Billed"), 0);
    assert.equal(await bal("2100 Accounts Payable"), -241.5);
    assert.equal(await bal("1600 Taxes Recoverable"), 31.5);
    assert.equal(await bal("5300 Stock Adjustments"), 10);
    const payable = await q()("Journal Entry Line").where({ account: "2100 Accounts Payable" }).first();
    assert.equal(payable.supplier, supplier);
    await assert.rejects(() => bills.makeBillFromReceipt(receipt.name), /already billed/);
  });
});

test("a bill can bring its stock, or be an expense", async () => {
  await t.run(async () => {
    const withStock = await draftBill({ update_stock: 1, lines: [{ item: "PAPER", quantity: 5, rate: 26 }] });
    await bills.postBill(withStock);
    assert.deepEqual(await sl.balanceOf("PAPER", MAIN), { qty: 15, value: 330, rate: 22 });

    const expense = await draftBill({ lines: [{ item: "POWER", quantity: 1, rate: 100 }] });
    await bills.postBill(expense);
    assert.equal(await bal("5200 Operating Expenses"), 100);
    await assert.rejects(async () => bills.postBill(await draftBill({ update_stock: 1, lines: [{ item: "PAPER", quantity: 1, rate: 20, receipt: receipt.name, receipt_line: (await receipt.lines)[0].name }] })), /already came into stock|left to bill/);
  });
});

test("supplier payments pay bills; what is left is an advance that pays a later bill", async () => {
  await t.run(async () => {
    const cash = await bal("1100 Cash");
    const payment = await bills.payBill(await loopar.getDocument(BILL, bill.name), { amount: 100, method: "Cash" });
    assert.equal(payment.status, "Posted");
    assert.equal(await loopar.db.getValue(BILL, "status", bill.name), "Partially Paid");
    assert.equal(Number(await loopar.db.getValue(BILL, "balance", bill.name)), 141.5);
    assert.equal(await bal("1100 Cash") - cash, -100);

    const advance = await loopar.newDocument("Supplier Payment", { supplier, payment_method: "Cash", amount: 500, allocations: [{ bill: bill.name, allocated_amount: 141.5 }] });
    await advance.save();
    await bills.postSupplierPayment(await loopar.getDocument("Supplier Payment", advance.name));
    assert.equal(await loopar.db.getValue(BILL, "status", bill.name), "Paid");
    assert.equal(await bal("1500 Supplier Advances"), 358.5);

    const later = await draftBill({ lines: [{ item: "POWER", quantity: 1, rate: 50 }] });
    await bills.postBill(later);
    await bills.applySupplierAdvance({ payment: advance.name, bill: later.name, amount: 57.5 });
    assert.equal(await loopar.db.getValue(BILL, "status", later.name), "Paid");
    assert.equal(await bal("1500 Supplier Advances"), 301);
    await assert.rejects(async () => bills.cancelBill(await loopar.getDocument(BILL, later.name)), /with payments cannot be cancelled/);

    await bills.cancelSupplierPayment(await loopar.getDocument("Supplier Payment", advance.name), { reason: "Wrong" });
    assert.equal(await loopar.db.getValue(BILL, "status", later.name), "Unpaid");
    assert.equal(await bal("1500 Supplier Advances"), 0);
  });
});

test("a debit note sends goods back, the supplier owes it, and it refunds or pays another bill", async () => {
  await t.run(async () => {
    const supplierBill = await draftBill({ update_stock: 1, lines: [{ item: "PAPER", quantity: 4, rate: 25 }, { item: "POWER", quantity: 1, rate: 40 }] });
    await bills.postBill(supplierBill); // 100 + 40 = 140 + 15% = 161
    const before = await sl.balanceOf("PAPER", MAIN);
    const payable = await bal("2100 Accounts Payable");

    const lines = await supplierBill.lines;
    const note = await loopar.getDocument(BILL, await bills.makeDebitNote(supplierBill.name, { reason: "Damaged", lines: [{ against_line: lines[0].name, quantity: 2 }] }));
    assert.match(note.name, /^DN-/);
    assert.deepEqual([note.bill_type, note.return_against, Number(note.total)], ["Debit Note", supplierBill.name, 57.5]);
    await bills.postBill(note);
    assert.equal(note.status, "Open");
    assert.equal((await sl.balanceOf("PAPER", MAIN)).qty, before.qty - 2);
    assert.equal(round(await bal("2100 Accounts Payable") - payable), 57.5, "the supplier owes it back");
    assert.equal(Number(await loopar.db.getValue(BILL, "debited_amount", supplierBill.name)), 57.5);
    await assert.rejects(async () => bills.postBill(await loopar.getDocument(BILL, await bills.makeDebitNote(supplierBill.name, { lines: [{ against_line: lines[0].name, quantity: 2 }] }).then(async (n) => {
      const d = await loopar.getDocument(BILL, n); d.lines = (await d.lines).map((l) => ({ ...l, quantity: 3 })); await d.save(); return n;
    }))), /more than the 2 left/);

    // Half applied to an open bill, the rest refunded in cash.
    const open = await draftBill({ lines: [{ item: "POWER", quantity: 1, rate: 20 }] }); // 23
    await bills.postBill(open);
    await bills.applySupplierAdvance({ payment: note.name, bill: open.name, amount: 23 });
    assert.equal(await loopar.db.getValue(BILL, "status", open.name), "Paid");
    const cash = await bal("1100 Cash");
    const refund = await bills.payBill(await loopar.getDocument(BILL, note.name), { amount: 34.5, method: "Cash" });
    assert.equal(refund.payment_type, "Refund");
    assert.equal(await loopar.db.getValue(BILL, "status", note.name), "Applied");
    assert.equal(round(await bal("1100 Cash") - cash), 34.5, "money came in");
    await assert.rejects(async () => bills.cancelBill(await loopar.getDocument(BILL, supplierBill.name), { reason: "x" }), /has debit notes/);
  });
});

const round = (v) => Math.round(v * 100) / 100;
