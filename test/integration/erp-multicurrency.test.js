import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loopar } from "loopar";
import { bootTestTenant } from "../support/tenant.js";

/*
 * Multicurrency: the books are in the company's currency (here HNL); a
 * document in another one (USD) keeps its own amounts, the ledger converts
 * them at the document's rate and keeps the original beside, and what is
 * settled at another rate leaves the difference in the exchange account.
 */

let t, cur, ledger, payments, bills, wo, reports, recon, customer, supplier;
const root = process.cwd();
const erp = (...p) => import(path.join(root, "apps", "erp", "modules", ...p));
const bal = async (account, party = null) => (await ledger.balances({ accounts: [account], ...(party ? { party } : {}) }))[account] || 0;
const AR = "1300 Accounts Receivable";
const AP = "2100 Accounts Payable";
const FX = "5700 Exchange Gain or Loss";
const linesOf = async (document, name) => {
  const out = [];
  for (const e of await ledger.entriesOf(document, name)) out.push(...(await (await loopar.getDocument("Journal Entry", e.name)).lines));
  return out;
};
const usdInvoice = async (date, quantity = 1) => {
  const inv = await loopar.newDocument("Invoice", { customer, invoice_date: date, lines: [{ item: "JOB", quantity }] });
  await inv.save();
  await (await loopar.getDocument("Invoice", inv.name)).issue();
  return await loopar.getDocument("Invoice", inv.name);
};

before(async () => {
  t = await bootTestTenant({ apps: ["erp"] });
  cur = await erp("accounting", "currencies.js");
  ledger = await erp("accounting", "ledger.js");
  payments = await erp("billing", "payments.js");
  bills = await erp("purchasing", "bills.js");
  wo = await erp("billing", "write-offs.js");
  reports = await erp("accounting", "reports.js");
  recon = await erp("accounting", "bank-reconciliation.js");
  (await erp("billing", "fiscal.js")).useFiscalProvider(null);
  await t.run(async () => {
    loopar.mail.send = async () => ({ ok: true });
    const company = await loopar.getDocument("Company");
    company.currency = "HNL";
    await company.save();
    await cur.ensureCurrencies();
    // USD is there already: it was the base while the company had no currency.
    const eur = await loopar.newDocument("Currency", { name: "eur" }); await eur.save();
    for (const [date, exchange_rate] of [["2026-11-01", 25], ["2026-11-10", 26]]) {
      await (await loopar.newDocument("Currency Exchange", { currency: "USD", date, exchange_rate })).save();
    }
    const { createCustomer } = await erp("crm", "customers.js");
    customer = await createCustomer({ customer_name: "Dollar Client", email: "usd@co.test" });
    const c = await loopar.getDocument("Customer", customer); c.currency = "USD"; await c.save();
    const s = await loopar.newDocument("Supplier", { supplier_name: "Dollar Supplier", currency: "USD" }); await s.save(); supplier = s.name;
    // Priced in the company's currency: 2,500 lempiras.
    const it = await loopar.newDocument("Item", { name: "JOB", item_name: "Job", item_type: "Service", rate: 2500 }); it.__KEEP_NAME__ = true; await it.save();
    const g = await loopar.newDocument("Item", { name: "GOOD", item_name: "Good", item_type: "Product", rate: 500, cost: 250, track_stock: 1 }); g.__KEEP_NAME__ = true; await g.save();
  });
});
after(async () => { await t?.teardown(); });

test("the company's currency is the base; rates apply from their date on", async () => {
  await t.run(async () => {
    assert.equal(await cur.baseCurrency(), "HNL");
    assert.ok(await loopar.db.count("Currency", "HNL"), "the company's currency is a Currency");
    assert.ok(await loopar.db.count("Currency", "USD"));
    assert.ok(await loopar.db.count("Currency", "EUR"), "codes are stored in capitals");
    assert.equal((await ledger.accountingSettings()).exchange_gain_loss_account, FX);
    assert.deepEqual([await cur.exchangeRate("HNL", "2026-11-05"), await cur.exchangeRate("USD", "2026-11-05"), await cur.exchangeRate("USD", "2026-11-10"), await cur.exchangeRate("USD", "2026-12-31"), await cur.exchangeRate("USD", "2026-10-15")],
      [1, 25, 26, 26, null]);
    await assert.rejects(async () => (await loopar.newDocument("Currency Exchange", { currency: "USD", date: "2026-11-10", exchange_rate: 27 })).save(), /already has a rate/);
    await assert.rejects(async () => (await loopar.newDocument("Currency Exchange", { currency: "HNL", date: "2026-11-10", exchange_rate: 2 })).save(), /company's currency/);
    await assert.rejects(async () => (await loopar.newDocument("Currency", { name: "XX" })).save(), /not a currency code/);
  });
});

test("an invoice in dollars keeps its amounts; the ledger books it in lempiras with the dollars beside", async () => {
  await t.run(async () => {
    const inv = await usdInvoice("2026-11-02");
    assert.deepEqual([inv.currency, Number(inv.exchange_rate), Number(inv.total), Number(inv.balance)], ["USD", 25, 100, 100], "the item's 2,500 lempiras are 100 dollars at 25");
    assert.equal(await bal(AR, customer), 2500);
    const receivable = (await linesOf("Invoice", inv.name)).find((l) => l.account === AR);
    assert.deepEqual([receivable.currency, Number(receivable.exchange_rate), Number(receivable.foreign_debit), Number(receivable.debit)], ["USD", 25, 100, 2500]);

    // Paid with 100 dollars when the dollar is at 26: 100 lempiras of exchange gain.
    const fx = await bal(FX);
    const bank = await bal("1200 Bank");
    const pay = await payments.receiveForInvoice(inv, { amount: 100, payment_date: "2026-11-12", method: "Bank Transfer" });
    assert.deepEqual([pay.currency, Number(pay.exchange_rate)], ["USD", 26]);
    const paid = await loopar.getDocument("Invoice", inv.name);
    assert.deepEqual([paid.status, Number(paid.balance)], ["Paid", 0], "100 dollars pay 100 dollars");
    assert.deepEqual([await bal(AR, customer), await bal("1200 Bank") - bank, await bal(FX) - fx], [0, 2600, -100]);

    // Cancelling the payment takes all of it back.
    await payments.cancelPayment(await loopar.getDocument("Payment", pay.name));
    assert.deepEqual([await bal(AR, customer), await bal("1200 Bank") - bank, await bal(FX) - fx], [2500, 0, 0]);
    assert.equal(Number((await loopar.getDocument("Invoice", inv.name)).balance), 100);
    // Written off at the invoice's rate, so Receivable is left at zero.
    await wo.writeOffInvoice(inv.name, { reason: "Test" });
    assert.deepEqual([await bal(AR, customer), await bal("5600 Write-offs")], [0, 2500]);
  });
});

test("a payment is in the currency of what it pays; an advance is applied at its own rate", async () => {
  await t.run(async () => {
    const inv = await usdInvoice("2026-11-11", 2); // 2,500 lempiras at 26 are 96.15 dollars each
    assert.deepEqual([Number(inv.exchange_rate), Number(inv.total)], [26, 192.3]);
    const wrong = await loopar.newDocument("Payment", { customer, currency: "HNL", amount: 100, payment_method: "Cash", allocations: [{ invoice: inv.name, allocated_amount: 100 }] });
    await assert.rejects(() => wrong.save(), /settled in its own currency/);

    // An advance of 50 dollars received at 25, applied to an invoice booked at 26.
    const adv = await loopar.newDocument("Payment", { customer, amount: 50, payment_date: "2026-11-03", payment_method: "Bank Transfer" });
    await adv.save();
    assert.deepEqual([adv.currency, Number(adv.exchange_rate)], ["USD", 25], "the customer's currency, the rate of the date");
    await payments.postPayment(await loopar.getDocument("Payment", adv.name));
    assert.equal(await bal("2300 Customer Advances", customer), -1250);
    assert.deepEqual((await payments.customerCredits(customer, "HNL")).length, 0);
    assert.equal((await payments.customerCredits(customer, "USD"))[0].available, 50);
    const fx = await bal(FX);
    const ar = await bal(AR, customer);
    await payments.applyCredit({ source: adv.name, invoice: inv.name, amount: 50, date: "2026-11-12" });
    // Receivable gives up 50 × 26 = 1,300; the advance was 1,250: 50 of exchange loss.
    assert.deepEqual([await bal("2300 Customer Advances", customer), await bal(AR, customer) - ar, await bal(FX) - fx], [0, -1300, 50]);
    assert.equal(Number((await loopar.getDocument("Invoice", inv.name)).balance), 142.3);

    // Aging is in the company's currency, with the document's own balance beside.
    const aging = await reports.receivablesAging();
    const row = aging.rows.find((r) => r.party === customer);
    const doc = row.documents.find((d) => d.name === inv.name);
    assert.deepEqual([doc.currency, doc.currency_balance, doc.balance], ["USD", 142.3, 3699.8]);
  });
});

test("a bill in dollars values its stock in lempiras; paying it later leaves the exchange difference", async () => {
  await t.run(async () => {
    const wh = (await loopar.db.getAll("Warehouse", ["name"]))[0].name;
    const bill = await loopar.newDocument("Purchase Invoice", { supplier, bill_date: "2026-11-02", update_stock: 1, warehouse: wh, lines: [{ item: "GOOD", quantity: 10 }] });
    await bill.save();
    assert.deepEqual([bill.currency, Number(bill.exchange_rate), Number(bill.total)], ["USD", 25, 100], "the cost of 250 lempiras is 10 dollars");
    await bills.postBill(await loopar.getDocument("Purchase Invoice", bill.name));
    const { balanceOf } = await erp("stock", "stock-ledger.js");
    const stock = await balanceOf("GOOD", wh);
    assert.deepEqual([stock.qty, stock.value, stock.rate], [10, 2500, 250]);
    assert.equal(await bal(AP), -2500);

    const fx = await bal(FX);
    const bank = await bal("1200 Bank");
    await bills.payBill(await loopar.getDocument("Purchase Invoice", bill.name), { amount: 100, payment_date: "2026-11-12", method: "Bank Transfer" });
    assert.equal((await loopar.getDocument("Purchase Invoice", bill.name)).status, "Paid");
    // 100 dollars cost 2,600 now; the bill was 2,500: 100 of exchange loss.
    assert.deepEqual([await bal(AP), await bal("1200 Bank") - bank, await bal(FX) - fx], [0, -2600, 100]);
  });
});

test("an account in dollars only takes dollars and is reconciled in dollars", async () => {
  await t.run(async () => {
    const acc = await loopar.newDocument("Account", { account_number: "1210", account_name: "Bank USD", root_type: "Asset", account_type: "Bank", parent_account: "1000 Assets", currency: "USD" });
    await acc.save();
    const method = await loopar.newDocument("Payment Method", { name: "USD Transfer", method_type: "Bank", account: acc.name }); method.__KEEP_NAME__ = true; await method.save();

    const { createCustomer } = await erp("crm", "customers.js");
    const local = await createCustomer({ customer_name: "Local Client", email: "hnl@co.test" });
    const hnl = await loopar.newDocument("Invoice", { customer: local, invoice_date: "2026-11-02", lines: [{ item: "JOB", quantity: 1 }] });
    await hnl.save();
    assert.deepEqual([hnl.currency, Number(hnl.exchange_rate), Number(hnl.total)], ["HNL", 1, 2500]);
    await (await loopar.getDocument("Invoice", hnl.name)).issue();
    await assert.rejects(() => payments.receiveForInvoice(hnl, { amount: 2500, payment_date: "2026-11-03", method: "USD Transfer" }), /kept in USD/);

    const inv = await usdInvoice("2026-11-02");
    await payments.receiveForInvoice(inv, { amount: 100, payment_date: "2026-11-03", method: "USD Transfer" });
    assert.equal(await bal(acc.name), 2500);
    const view = await recon.reconciliation({ account: acc.name, to: "2026-11-30" });
    assert.deepEqual([view.currency, view.book_balance, view.lines[0].deposit], ["USD", 100, 100]);

    // A manual entry on it: the dollars and the rate give the lempiras.
    const je = await loopar.newDocument("Journal Entry", { posting_date: "2026-11-12", lines: [
      { account: acc.name, foreign_debit: 10 }, { account: "3100 Owner's Equity", credit: 260 },
    ] });
    await je.save();
    assert.deepEqual([Number(je.total_debit), Number(je.total_credit)], [260, 260]);
    const bad = await loopar.newDocument("Journal Entry", { posting_date: "2026-11-12", lines: [{ account: acc.name, debit: 260 }, { account: "3100 Owner's Equity", credit: 260 }] });
    await assert.rejects(() => bad.save(), /type the amount in USD/);
  });
});

test("a credit note takes the invoice's currency and rate", async () => {
  await t.run(async () => {
    const inv = await usdInvoice("2026-11-02");
    const { makeCreditNote } = await erp("billing", "credit-notes.js");
    const ar = await bal(AR, customer);
    const name = await makeCreditNote(inv.name, { reason: "Wrong price" });
    const note = await loopar.getDocument("Invoice", name);
    assert.deepEqual([note.currency, Number(note.exchange_rate), Number(note.total)], ["USD", 25, 100]);
    await note.issue();
    assert.equal(await bal(AR, customer) - ar, -2500);
    await payments.applyCredit({ source: name, invoice: inv.name, amount: 100 });
    assert.equal((await loopar.getDocument("Invoice", inv.name)).status, "Paid");
  });
});

test("credit applied to an invoice booked at another rate leaves the difference in the exchange account, and gives it back", async () => {
  await t.run(async () => {
    const first = await usdInvoice("2026-11-02"); // at 25
    const { makeCreditNote } = await erp("billing", "credit-notes.js");
    const note = await loopar.getDocument("Invoice", await makeCreditNote(first.name, { reason: "Returned" }));
    await note.issue();
    const second = await usdInvoice("2026-11-11"); // 96.15 dollars at 26
    const fx = await bal(FX);
    const ar = await bal(AR, customer);
    await payments.applyCredit({ source: note.name, invoice: second.name, amount: 96.15, date: "2026-11-12" });
    // The note took 96.15 × 25 from Receivable; the invoice put 96.15 × 26: 96.15 of loss.
    assert.deepEqual([Math.round((await bal(AR, customer) - ar) * 100) / 100, Math.round((await bal(FX) - fx) * 100) / 100], [-96.15, 96.15]);
    assert.equal((await loopar.getDocument("Invoice", second.name)).status, "Paid");
    await payments.unapplyCredit({ invoice: second.name, credit_note: note.name });
    assert.deepEqual([Math.round((await bal(AR, customer) - ar) * 100) / 100, Math.round((await bal(FX) - fx) * 100) / 100], [0, 0]);
  });
});

test("a receipt is billed in the supplier's currency: the price difference is measured in the books' currency", async () => {
  await t.run(async () => {
    const wh = (await loopar.db.getAll("Warehouse", ["name"]))[0].name;
    const entries = await erp("stock", "stock-entries.js");
    const r = await loopar.newDocument("Stock Entry", { entry_type: "Receipt", supplier, posting_date: "2026-11-02", default_warehouse: wh, lines: [{ item: "GOOD", qty: 4, unit_cost: 250 }] });
    await r.save();
    await entries.postStockEntry(await loopar.getDocument("Stock Entry", r.name));
    const name = await bills.makeBillFromReceipt(r.name);
    const bill = await loopar.getDocument("Purchase Invoice", name);
    const line = (await bill.lines)[0];
    assert.equal(bill.currency, "USD");
    assert.equal(Number(line.rate), Math.round((250 / Number(bill.exchange_rate)) * 100) / 100, "the receipt's cost, in dollars");
    // Billed at 10 dollars with the dollar at 26: 260 against the 250 received.
    bill.bill_date = "2026-11-12"; bill.exchange_rate = 26; bill.lines = [{ ...line, rate: 10 }];
    await bill.save();
    const adj = await bal("5300 Stock Adjustments");
    const srnb = await bal("2150 Stock Received Not Billed");
    const ap = await bal(AP);
    await bills.postBill(await loopar.getDocument("Purchase Invoice", name));
    assert.deepEqual([await bal("2150 Stock Received Not Billed") - srnb, await bal("5300 Stock Adjustments") - adj, await bal(AP) - ap], [1000, 40, -1040]);
  });
});

test("a quote in dollars takes the rate of its date; changing the currency changes the rate", async () => {
  await t.run(async () => {
    const q = await loopar.newDocument("Quote", { customer, quote_date: "2026-11-02", lines: [{ item: "JOB", quantity: 1 }] });
    await q.save();
    assert.deepEqual([q.currency, Number(q.exchange_rate), Number(q.total)], ["USD", 25, 100]);
    // Changing the currency drops the rate that was the other one's.
    const again = await loopar.getDocument("Quote", q.name);
    again.currency = "HNL";
    await again.save();
    assert.deepEqual([again.currency, Number(again.exchange_rate)], ["HNL", 1]);
    again.currency = "USD";
    await again.save();
    assert.deepEqual([again.currency, Number(again.exchange_rate)], ["USD", 25]);
    // A rate typed on the document wins over the recorded one.
    again.exchange_rate = 24.5;
    await again.save();
    assert.equal(Number((await loopar.getDocument("Quote", q.name)).exchange_rate), 24.5);
    const eur = await loopar.newDocument("Quote", { customer, currency: "EUR", lines: [{ item: "JOB", quantity: 1 }] });
    await assert.rejects(() => eur.save(), /no exchange rate for EUR/);
  });
});
