import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loopar } from "loopar";
import { bootTestTenant } from "../support/tenant.js";

/*
 * Bank reconciliation: the bank lines still to clear as of a statement
 * date explain the difference between books and bank; clearing them takes
 * them out; a payment cancelled before the bank saw it leaves with its
 * reversal.
 */

let t, brc, payments, bills, customer, supplier, invoice;
const root = process.cwd();
const erp = (...p) => import(path.join(root, "apps", "erp", "modules", ...p));
const BANK = "1200 Bank";

before(async () => {
  t = await bootTestTenant({ apps: ["erp"] });
  brc = await erp("accounting", "bank-reconciliation.js");
  payments = await erp("billing", "payments.js");
  bills = await erp("purchasing", "bills.js");
  (await erp("billing", "fiscal.js")).useFiscalProvider(null);
  await t.run(async () => {
    loopar.mail.send = async () => ({ ok: true });
    const { createCustomer } = await erp("crm", "customers.js");
    customer = await createCustomer({ customer_name: "Bank Co", email: "bank@co.test" });
    const s = await loopar.newDocument("Supplier", { supplier_name: "Paper Co" }); await s.save(); supplier = s.name;
    const it = await loopar.newDocument("Item", { name: "SVC", item_name: "Service", item_type: "Service", rate: 100 }); it.__KEEP_NAME__ = true; await it.save();
    const inv = await loopar.newDocument("Invoice", { customer, invoice_date: "2026-10-01", lines: [{ item: "SVC", quantity: 2 }] });
    await inv.save();
    invoice = inv.name;
    await (await loopar.getDocument("Invoice", inv.name)).issue();
    await payments.receiveForInvoice(await loopar.getDocument("Invoice", invoice), { amount: 100, payment_date: "2026-10-05", method: "Bank Transfer" });
    const b = await loopar.newDocument("Purchase Invoice", { supplier, bill_date: "2026-10-02", lines: [{ description: "Paper", quantity: 1, rate: 40 }] });
    await b.save();
    await bills.postBill(await loopar.getDocument("Purchase Invoice", b.name));
    await bills.payBill(await loopar.getDocument("Purchase Invoice", b.name), { amount: 40, payment_date: "2026-10-06", method: "Bank Transfer" });
  });
});
after(async () => { await t?.teardown(); });

test("the lines to clear explain the difference between books and bank", async () => {
  await t.run(async () => {
    assert.ok((await brc.bankAccounts()).some((a) => a.name === BANK));
    const r = await brc.reconciliation({ account: BANK, to: "2026-10-31" });
    assert.deepEqual([r.book_balance, r.outstanding_deposits, r.outstanding_withdrawals, r.expected_bank_balance], [60, 100, 40, 0]);
    assert.deepEqual(r.lines.map((l) => [l.posting_date, l.deposit, l.withdrawal]), [["2026-10-05", 100, 0], ["2026-10-06", 0, 40]]);
    await assert.rejects(() => brc.reconciliation({ account: "4100 Sales" }), /not a bank or cash account/);
  });
});

test("cleared lines leave the list (as of their clearance date)", async () => {
  await t.run(async () => {
    const { lines } = await brc.reconciliation({ account: BANK, to: "2026-10-31" });
    const deposit = lines.find((l) => l.deposit);
    await assert.rejects(() => brc.clearLines({ account: BANK, lines: [{ id: deposit.id, clearance_date: "2026-10-01" }] }), /cannot clear on/);
    await brc.clearLines({ account: BANK, lines: [{ id: deposit.id, clearance_date: "2026-10-07" }] });
    let r = await brc.reconciliation({ account: BANK, to: "2026-10-31" });
    assert.deepEqual([r.lines.length, r.expected_bank_balance], [1, 100]);
    // As of a statement before it cleared, it is still outstanding.
    r = await brc.reconciliation({ account: BANK, to: "2026-10-06" });
    assert.deepEqual([r.lines.length, r.lines[0].clearance_date], [2, "2026-10-07"]);
    // Un-clearing puts it back.
    await brc.clearLines({ account: BANK, lines: [{ id: deposit.id, clearance_date: null }] });
    assert.equal((await brc.reconciliation({ account: BANK, to: "2026-10-31" })).lines.length, 2);
  });
});

test("a payment cancelled before the bank saw it leaves with its reversal", async () => {
  await t.run(async () => {
    const pay = await payments.receiveForInvoice(await loopar.getDocument("Invoice", invoice), { amount: 50, payment_date: "2026-10-10", method: "Bank Transfer" });
    const name = pay?.name || (await loopar.db.getAll("Payment", ["name", "amount"])).find((p) => Number(p.amount) === 50).name;
    assert.equal((await brc.reconciliation({ account: BANK })).lines.length, 3);
    await payments.cancelPayment(await loopar.getDocument("Payment", name), { reason: "Bounced" });
    const r = await brc.reconciliation({ account: BANK });
    assert.deepEqual([r.lines.length, r.book_balance, r.expected_bank_balance], [2, 60, 0]);
  });
});
