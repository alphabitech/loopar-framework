import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loopar } from "loopar";
import { bootTestTenant } from "../support/tenant.js";

/*
 * Period closing: income and expenses up to the closing date go to retained
 * earnings, the books close up to it, the reports read around it, and the
 * latest closing can be cancelled (the books reopen as they were).
 */

let t, closing, ledger, reports, bills, customer, supplier;
const root = process.cwd();
const erp = (...p) => import(path.join(root, "apps", "erp", "modules", ...p));
const q = () => loopar.db.qx();
const RE = "3300 Retained Earnings";

before(async () => {
  t = await bootTestTenant({ apps: ["erp"] });
  closing = await erp("accounting", "closing.js");
  ledger = await erp("accounting", "ledger.js");
  reports = await erp("accounting", "reports.js");
  bills = await erp("purchasing", "bills.js");
  (await erp("billing", "fiscal.js")).useFiscalProvider(null);
  await t.run(async () => {
    loopar.mail.send = async () => ({ ok: true });
    const { createCustomer } = await erp("crm", "customers.js");
    customer = await createCustomer({ customer_name: "Year Co", email: "year@co.test" });
    const s = await loopar.newDocument("Supplier", { supplier_name: "Landlord" }); await s.save(); supplier = s.name;
    const it = await loopar.newDocument("Item", { name: "SVC", item_name: "Service", item_type: "Service", rate: 100 }); it.__KEEP_NAME__ = true; await it.save();
    const inv = await loopar.newDocument("Invoice", { customer, invoice_date: "2025-06-01", lines: [{ item: "SVC", quantity: 1 }] });
    await inv.save();
    await (await loopar.getDocument("Invoice", inv.name)).issue();
    const b = await loopar.newDocument("Purchase Invoice", { supplier, bill_date: "2025-07-01", lines: [{ description: "Rent", quantity: 1, rate: 30 }] });
    await b.save();
    await bills.postBill(await loopar.getDocument("Purchase Invoice", b.name));
  });
});
after(async () => { await t?.teardown(); });

const newClosing = async (values) => {
  const d = await loopar.newDocument("Period Closing", values);
  await d.save();
  return await loopar.getDocument("Period Closing", d.name);
};
const entryLines = async (entry) => Object.fromEntries((await q()("Journal Entry Line").where({ parent_document: "Journal Entry" })
  .whereIn("parent_id", q()("Journal Entry").select("id").where({ name: entry }))).map((l) => [l.account, Number(l.debit) - Number(l.credit)]));

let pcv;
test("closing a year takes its profit to retained earnings and closes the books", async () => {
  await t.run(async () => {
    pcv = await newClosing({ closing_date: "2025-12-31", lock_books: 1 });
    await closing.postClosing(pcv);
    pcv = await loopar.getDocument("Period Closing", pcv.name);
    assert.deepEqual([pcv.status, Number(pcv.net_profit), pcv.closing_account], ["Posted", 70, RE]);
    assert.deepEqual(await entryLines(pcv.journal_entry), { "4100 Sales": 100, "5200 Operating Expenses": -30, [RE]: -70 });
    assert.equal(String((await ledger.accountingSettings()).lock_date).slice(0, 10), "2025-12-31");
    await assert.rejects(() => ledger.checkOpenPeriod("2025-12-15"), /closed up to 2025-12-31/);
  });
});

test("the reports read around the closing", async () => {
  await t.run(async () => {
    const pnl = await reports.profitAndLoss({ from: "2025-01-01", to: "2025-12-31" });
    assert.equal(pnl.net_profit, 70, "the year's profit and loss still shows its income and expenses");
    const bs = await reports.balanceSheet({ as_of: "2025-12-31" });
    assert.deepEqual([bs.unclosed_earnings, bs.balanced], [0, true]);
    assert.ok(bs.equity.rows.some((r) => r.account === RE && Number(r.amount) === 70));
  });
});

test("a closing goes after the last one; only the latest is cancelled and the books reopen", async () => {
  await t.run(async () => {
    await assert.rejects(async () => closing.postClosing(await newClosing({ closing_date: "2025-06-30" })), /already closed to 2025-12-31/);
    await closing.cancelClosing(pcv, { reason: "Late invoice" });
    const s = await ledger.accountingSettings();
    assert.ok(!s.lock_date, "the books reopen as they were");
    const bs = await reports.balanceSheet({ as_of: "2025-12-31" });
    assert.equal(bs.unclosed_earnings, 70);
    assert.equal((await reports.profitAndLoss({ from: "2025-01-01", to: "2025-12-31" })).net_profit, 70);
    await assert.rejects(async () => closing.postClosing(await newClosing({ closing_date: "2024-12-31" })), /nothing to close/);
  });
});
