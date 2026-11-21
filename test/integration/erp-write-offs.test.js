import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loopar } from "loopar";
import { bootTestTenant } from "../support/tenant.js";

/*
 * Write-offs: what is left of an invoice or bill closed against the
 * write-off account, shown as a "Write-off" row, and taken back by
 * reversing its entry.
 */

let t, wo, ledger, payments, bills, customer, supplier;
const root = process.cwd();
const erp = (...p) => import(path.join(root, "apps", "erp", "modules", ...p));
const bal = async (account, party = null) => (await ledger.balances({ accounts: [account], ...(party ? { party } : {}) }))[account] || 0;
const WO = "5600 Write-offs";

before(async () => {
  t = await bootTestTenant({ apps: ["erp"] });
  wo = await erp("billing", "write-offs.js");
  ledger = await erp("accounting", "ledger.js");
  payments = await erp("billing", "payments.js");
  bills = await erp("purchasing", "bills.js");
  (await erp("billing", "fiscal.js")).useFiscalProvider(null);
  await t.run(async () => {
    loopar.mail.send = async () => ({ ok: true });
    const { createCustomer } = await erp("crm", "customers.js");
    customer = await createCustomer({ customer_name: "Slow Payer", email: "slow@co.test" });
    const s = await loopar.newDocument("Supplier", { supplier_name: "Kind Supplier" }); await s.save(); supplier = s.name;
    const it = await loopar.newDocument("Item", { name: "JOB", item_name: "Job", item_type: "Service", rate: 100 }); it.__KEEP_NAME__ = true; await it.save();
  });
});
after(async () => { await t?.teardown(); });

test("installing adds the write-off account and points the settings at it", async () => {
  await t.run(async () => {
    assert.equal((await ledger.accountingSettings()).write_off_account, WO);
  });
});

test("an invoice's rest is written off against the write-off account, and can be taken back", async () => {
  await t.run(async () => {
    const inv = await loopar.newDocument("Invoice", { customer, lines: [{ item: "JOB", quantity: 1 }] });
    await inv.save();
    let doc = await loopar.getDocument("Invoice", inv.name);
    await doc.issue();
    await payments.receiveForInvoice(await loopar.getDocument("Invoice", inv.name), { amount: 97, payment_date: "2026-11-01", method: "Cash" });

    await assert.rejects(() => wo.writeOffInvoice(inv.name, { amount: 3 }), /why/);
    await assert.rejects(() => wo.writeOffInvoice(inv.name, { amount: 4, reason: "Too much" }), /more than the balance/);
    const r = await wo.writeOffInvoice(inv.name, { reason: "Small difference" });
    assert.equal(Number(r.balance), 0);
    doc = await loopar.getDocument("Invoice", inv.name);
    assert.equal(doc.status, "Paid");
    const row = (await doc.payments).find((p) => p.method === "Write-off");
    assert.deepEqual([Number(row.amount), row.journal_entry, row.notes], [3, r.journal_entry, "Small difference"]);
    assert.deepEqual([await bal(WO), await bal("1300 Accounts Receivable", customer)], [3, 0]);

    await wo.undoInvoiceWriteOff(inv.name, { row: r.journal_entry });
    doc = await loopar.getDocument("Invoice", inv.name);
    assert.deepEqual([Number(doc.balance), doc.status !== "Paid"], [3, true]);
    assert.deepEqual([await bal(WO), await bal("1300 Accounts Receivable", customer)], [0, 3]);
    assert.equal((await doc.payments).filter((p) => p.method === "Write-off").length, 0);
  });
});

test("a bill's rest the supplier waives is written off (a gain on the same account)", async () => {
  await t.run(async () => {
    const b = await loopar.newDocument("Purchase Invoice", { supplier, lines: [{ description: "Repairs", quantity: 1, rate: 250 }] });
    await b.save();
    await bills.postBill(await loopar.getDocument("Purchase Invoice", b.name));
    const before = await bal(WO);
    const r = await wo.writeOffBill(b.name, { amount: 10, reason: "Discount agreed" });
    assert.equal(Number(r.balance), 240);
    assert.equal(await bal(WO) - before, -10);
    const bill = await loopar.getDocument("Purchase Invoice", b.name);
    assert.equal(bill.status, "Partially Paid");
    await assert.rejects(() => wo.writeOffBill(b.name, { amount: 500, reason: "x" }), /more than the balance/);
    await wo.undoBillWriteOff(b.name, { row: r.journal_entry });
    assert.equal(Number((await loopar.getDocument("Purchase Invoice", b.name)).balance), 250);
  });
});
