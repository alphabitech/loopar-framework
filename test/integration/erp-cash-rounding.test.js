import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loopar } from "loopar";
import { bootTestTenant } from "../support/tenant.js";

/*
 * Cash rounding: quotes, invoices and tickets round their total to a step
 * (the settings', the register's or their own); the difference is posted to
 * the rounding account; a register may round only tickets paid in cash.
 */

let t, pos, ledger, totals, customer;
const root = process.cwd();
const erp = (...p) => import(path.join(root, "apps", "erp", "modules", ...p));
const q = () => loopar.db.qx();
const entryLines = async (entry) => Object.fromEntries((await q()("Journal Entry Line").where({ parent_document: "Journal Entry" })
  .whereIn("parent_id", q()("Journal Entry").select("id").where({ name: entry })))
  .map((l) => [l.account, round2(Number(l.debit) - Number(l.credit))]));
const round2 = (v) => Math.round(v * 100) / 100;

before(async () => {
  t = await bootTestTenant({ apps: ["erp"] });
  pos = await erp("sales", "pos.js");
  ledger = await erp("accounting", "ledger.js");
  totals = await erp("billing", "totals.js");
  (await erp("billing", "fiscal.js")).useFiscalProvider(null);
  await t.run(async () => {
    loopar.mail.send = async () => ({ ok: true });
    const { createCustomer } = await erp("crm", "customers.js");
    customer = await createCustomer({ customer_name: "Round Co", email: "round@co.test" });
    await (await loopar.newDocument("Tax Template", { name: "VAT 15", tax_name: "VAT", rate: 15 })).save();
    const it = await loopar.newDocument("Item", { name: "TEA", item_name: "Tea", item_type: "Service", rate: 9.02, tax_template: "VAT 15" });
    it.__KEEP_NAME__ = true;
    await it.save();
    const s = await loopar.getDocument("Accounting Settings");
    s.cash_rounding = 0.05;
    await s.save();
  });
});
after(async () => { await t?.teardown(); });

test("totals round to the step, half away from zero", () => {
  assert.deepEqual([totals.roundTo(10.37, 0.05), totals.roundTo(10.38, 0.05), totals.roundTo(10.37, 1), totals.roundTo(-10.38, 0.05), totals.roundTo(10.37, 0)], [10.35, 10.4, 10, -10.4, 10.37]);
});

test("an invoice rounds by the settings (or its own step) and posts the difference to rounding", async () => {
  await t.run(async () => {
    const inv = await loopar.newDocument("Invoice", { customer, lines: [{ item: "TEA", quantity: 1 }] });
    await inv.save();
    const doc = await loopar.getDocument("Invoice", inv.name);
    // 9.02 + 15% = 10.37 → 10.35
    assert.deepEqual([Number(doc.cash_rounding), Number(doc.tax_amount), Number(doc.rounding_adjustment), Number(doc.total)], [0.05, 1.35, -0.02, 10.35]);
    await doc.issue();
    const [entry] = await ledger.entriesOf("Invoice", doc.name);
    assert.deepEqual(await entryLines(entry.name), { "1300 Accounts Receivable": 10.35, "4100 Sales": -9.02, "2200 Taxes Payable": -1.35, "5900 Rounding Differences": 0.02 });

    const exact = await loopar.newDocument("Invoice", { customer, cash_rounding: 0, lines: [{ item: "TEA", quantity: 1 }] });
    await exact.save();
    assert.equal(Number((await loopar.getDocument("Invoice", exact.name)).total), 10.37);

    const { makeCreditNote } = await erp("billing", "credit-notes.js");
    const cn = await loopar.getDocument("Invoice", await makeCreditNote(doc.name, { reason: "Back" }));
    assert.deepEqual([Number(cn.cash_rounding), Number(cn.total)], [0.05, 10.35]);
  });
});

test("the register rounds cash tickets; with round-cash-only a card pays the exact total", async () => {
  await t.run(async () => {
    const profile = await pos.ensurePosProfile();
    const p = await loopar.getDocument("POS Profile", profile);
    p.cash_rounding = 1;
    p.round_cash_only = 1;
    await p.save();
    await pos.openShift({ pos_profile: profile, opening_cash: 0 });
    const cat = await pos.catalog(profile);
    assert.deepEqual([cat.cash_rounding, cat.round_cash_only], [1, true]);

    const cash = await pos.checkout({ lines: [{ item: "TEA", quantity: 1 }], payments: [{ payment_method: "Cash", amount: 10 }] });
    assert.equal(Number(cash.total), 10);
    const inv = await loopar.getDocument("Invoice", cash.invoice);
    assert.deepEqual([Number(inv.total), Number(inv.rounding_adjustment), Number(inv.balance)], [10, -0.37, 0]);

    const card = (await pos.profileMethods(profile)).find((m) => m.method_type !== "Cash");
    assert.ok(card, "the register takes a card");
    const paid = await pos.checkout({ lines: [{ item: "TEA", quantity: 1 }], payments: [{ payment_method: card.name, amount: 10.37 }] });
    assert.equal(Number(paid.total), 10.37);
  });
});

test("the billing print formats show the rounding (hidden when zero)", async () => {
  await t.run(async () => {
    for (const name of ["Invoice Customer", "Quote Customer", "POS Receipt"]) {
      const s = (await q()("Print Format Builder").where({ name }).first("doc_structure")).doc_structure;
      assert.ok(s.includes('"field":"rounding_adjustment"') && s.includes('"hide_zero":1'), name);
    }
  });
});
