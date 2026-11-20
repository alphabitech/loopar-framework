import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loopar } from "loopar";
import { bootTestTenant } from "../support/tenant.js";

/*
 * POS: line discounts within the register's limit, prices only where the
 * register lets the cashier set them, cash in and out of the drawer during
 * the shift, and a closing that keeps the taxes and items of the shift.
 */

let t, pos, ledger, profile;
const root = process.cwd();
const erp = (...p) => import(path.join(root, "apps", "erp", "modules", ...p));
const bal = async (account) => (await ledger.balances({ accounts: [account] }))[account] || 0;

before(async () => {
  t = await bootTestTenant({ apps: ["erp"] });
  pos = await erp("sales", "pos.js");
  ledger = await erp("accounting", "ledger.js");
  const fiscal = await erp("billing", "fiscal.js");
  fiscal.useFiscalProvider(null);
  await t.run(async () => {
    await (await loopar.newDocument("Tax Template", { name: "VAT 15", tax_name: "VAT", rate: 15 })).save();
    const it = await loopar.newDocument("Item", { name: "CLASS", item_name: "Class", item_type: "Service", rate: 100, tax_template: "VAT 15" });
    it.__KEEP_NAME__ = true;
    await it.save();
    profile = await pos.ensurePosProfile();
    const p = await loopar.getDocument("POS Profile", profile);
    p.max_discount_percent = 20;
    await p.save();
    await pos.openShift({ pos_profile: profile, opening_cash: 50 });
  });
});
after(async () => { await t?.teardown(); });

test("the receipt and shift report formats are installed", async () => {
  await t.run(async () => {
    const formats = await loopar.db.getAll("Print Format Builder", ["name", "for_entity", "paper_size"], { name: ["POS Receipt", "Shift Report"] }).catch(() => []);
    const all = await loopar.db.getAll("Print Format Builder", ["name", "for_entity", "paper_size"]);
    const byName = Object.fromEntries(all.map((f) => [f.name, f]));
    assert.deepEqual([byName["POS Receipt"]?.for_entity, byName["POS Receipt"]?.paper_size], ["Invoice", "Receipt 80mm"]);
    assert.equal(byName["Shift Report"]?.for_entity, "Cash Shift");
    assert.equal((await pos.catalog(profile)).print_format, "POS Receipt");
  });
});

test("line discounts stay within the limit; prices are the items' unless the register allows changing them", async () => {
  await t.run(async () => {
    await assert.rejects(() => pos.checkout({ lines: [{ item: "CLASS", discount_percent: 30 }], payments: [{ payment_method: "Cash", amount: 200 }] }), /highest discount/);
    // 100 − 10% = 90 + 15% = 103.50; a typed price is ignored here.
    const sale = await pos.checkout({ lines: [{ item: "CLASS", rate: 1, discount_percent: 10 }], payments: [{ payment_method: "Cash", amount: 103.5 }] });
    assert.equal(Number(sale.total), 103.5);
    const inv = await loopar.getDocument("Invoice", sale.invoice);
    assert.deepEqual((await inv.lines).map((l) => [Number(l.rate), Number(l.discount_percent)]), [[100, 10]]);

    const p = await loopar.getDocument("POS Profile", profile);
    p.allow_rate_change = 1;
    await p.save();
    const priced = await pos.checkout({ lines: [{ item: "CLASS", rate: 80 }], payments: [{ payment_method: "Cash", amount: 92 }] });
    assert.equal(Number(priced.total), 92);
  });
});

test("cash in and out of the drawer is posted and counted in the shift", async () => {
  await t.run(async () => {
    const bank = await bal("1200 Bank");
    const out = await pos.moveCash({ movement_type: "Out", amount: 100, reason: "Deposit" });
    assert.equal(out.status, "Posted");
    assert.equal(await bal("1200 Bank") - bank, 100);
    await pos.moveCash({ movement_type: "In", amount: 20, reason: "Change" });
    await assert.rejects(() => pos.moveCash({ movement_type: "Out", amount: 10000, reason: "Too much" }), /in the drawer/);
    const extra = await pos.moveCash({ movement_type: "Out", amount: 5, reason: "Mistake" });
    await pos.cancelCashMovement(extra.name, { reason: "Typo" });

    const shift = await pos.openShiftOf();
    const totals = await pos.shiftTotals(shift.name);
    // 50 opening + 103.50 + 92 − 100 + 20
    assert.deepEqual([totals.cash_in, totals.cash_out, totals.cash_expected], [20, 100, 165.5]);
  });
});

test("closing keeps the taxes by rate and the items of the shift", async () => {
  await t.run(async () => {
    const shift = await pos.openShiftOf();
    await pos.closeShift(shift, { counted: { Cash: 165.5 } });
    const closed = await loopar.getDocument("Cash Shift", shift.name);
    assert.deepEqual((await closed.taxes).map((r) => [Number(r.rate), Number(r.base), Number(r.amount)]), [[15, 170, 25.5]]);
    assert.deepEqual((await closed.items).map((r) => [r.item, Number(r.quantity), Number(r.amount)]), [["CLASS", 2, 170]]);
    assert.deepEqual([Number(closed.cash_in), Number(closed.cash_out), Number(closed.cash_difference)], [20, 100, 0]);
  });
});
