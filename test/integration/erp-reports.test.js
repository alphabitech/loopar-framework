import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loopar } from "loopar";
import { bootTestTenant } from "../support/tenant.js";

/*
 * Reports read the ledgers: after selling, buying, receiving stock and
 * being paid, the trial balance and the balance sheet balance, profit is
 * income − expenses, aging shows what is open, and stock agrees with books.
 */

let t, r, customer, supplier;
const root = process.cwd();
const erp = (...p) => import(path.join(root, "apps", "erp", "modules", ...p));

before(async () => {
  t = await bootTestTenant({ apps: ["erp"] });
  r = await erp("accounting", "reports.js");
  const se = await erp("stock", "stock-entries.js");
  const bills = await erp("purchasing", "bills.js");
  const fiscal = await erp("billing", "fiscal.js");
  fiscal.useFiscalProvider(null);
  await t.run(async () => {
    loopar.mail.send = async () => ({ ok: true });
    const { createCustomer } = await erp("crm", "customers.js");
    customer = await createCustomer({ customer_name: "Report Buyer", email: "rb@co.test" });
    const s = await loopar.newDocument("Supplier", { supplier_name: "Report Supplier" });
    await s.save();
    supplier = s.name;
    await (await loopar.newDocument("Tax Template", { name: "VAT 15", tax_name: "VAT", rate: 15 })).save();
    const it = await loopar.newDocument("Item", { name: "CHAIR", item_name: "Chair", item_type: "Product", rate: 100, cost: 40, track_stock: 1, tax_template: "VAT 15" });
    it.__KEEP_NAME__ = true;
    await it.save();
    const rec = await loopar.newDocument("Stock Entry", { entry_type: "Receipt", supplier, lines: [{ item: "CHAIR", qty: 10, unit_cost: 40 }] });
    await rec.save();
    await se.postStockEntry(await loopar.getDocument("Stock Entry", rec.name));
    await bills.postBill(await loopar.getDocument("Purchase Invoice", await bills.makeBillFromReceipt(rec.name))); // 400 + 60 tax
    const inv = await loopar.newDocument("Invoice", { customer, lines: [{ item: "CHAIR", quantity: 3 }] });
    await inv.save();
    const doc = await loopar.getDocument("Invoice", inv.name);
    await doc.issue(); // 300 + 45 = 345, cost 120
    await doc.recordPayment({ amount: 145, method: "Cash" });
  });
});
after(async () => { await t?.teardown(); });

test("the trial balance and the balance sheet balance", async () => {
  await t.run(async () => {
    const tb = await r.trialBalance({});
    assert.ok(tb.balanced);
    assert.ok(tb.rows.some((x) => x.account === "1400 Inventory" && x.closing_debit === 280));
    const bs = await r.balanceSheet({});
    assert.ok(bs.balanced, JSON.stringify({ a: bs.assets.total, l: bs.liabilities.total, e: bs.equity.total, p: bs.unclosed_earnings }));
    assert.equal(bs.unclosed_earnings, 180);
  });
});

test("profit and loss: sales − cost of goods", async () => {
  await t.run(async () => {
    const pl = await r.profitAndLoss({});
    assert.deepEqual([pl.income.total, pl.expense.total, pl.net_profit], [300, 120, 180]);
    assert.ok(pl.income.rows.some((x) => x.is_group && x.account.startsWith("4000")), "groups carry their accounts' total");
  });
});

test("the general ledger runs a balance per account", async () => {
  await t.run(async () => {
    const gl = await r.generalLedger({ account: "1300 Accounts Receivable" });
    assert.equal(gl.closing, 200);
    assert.deepEqual(gl.rows.map((x) => x.balance), [345, 200]);
  });
});

test("aging shows what customers owe and what is owed to suppliers", async () => {
  await t.run(async () => {
    const ar = await r.receivablesAging();
    assert.equal(ar.totals.total, 200);
    assert.equal(ar.rows[0].name, "Report Buyer");
    const ap = await r.payablesAging();
    assert.equal(ap.totals.total, 460);
    assert.equal(ap.rows[0].documents.length, 1);
  });
});

test("stock balance agrees with the inventory account", async () => {
  await t.run(async () => {
    const sb = await r.stockBalance({});
    assert.deepEqual(sb.rows.map((x) => [x.item, x.qty, x.value]), [["CHAIR", 7, 280]]);
    const check = await r.stockAgainstLedger({});
    assert.deepEqual(check.map((c) => c.difference), [0]);
  });
});
