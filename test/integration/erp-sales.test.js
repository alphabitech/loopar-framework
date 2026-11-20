import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loopar } from "loopar";
import { bootTestTenant } from "../support/tenant.js";

/*
 * Point of sale: a shift is opened on a register, tickets are invoiced and
 * paid at once (change from cash), the shift closes counting the money and
 * posts the differences; a cancelled ticket gives everything back.
 */

let t, pos, ledger, sl, se, fiscal, profile;
const root = process.cwd();
const erp = (...p) => import(path.join(root, "apps", "erp", "modules", ...p));
const q = () => loopar.db.qx();
const bal = async (account) => (await ledger.balances({ accounts: [account] }))[account] || 0;

before(async () => {
  t = await bootTestTenant({ apps: ["erp"] });
  pos = await erp("sales", "pos.js");
  ledger = await erp("accounting", "ledger.js");
  sl = await erp("stock", "stock-ledger.js");
  se = await erp("stock", "stock-entries.js");
  fiscal = await erp("billing", "fiscal.js");
  fiscal.useFiscalProvider(null);
  await t.run(async () => {
    await (await loopar.newDocument("Tax Template", { name: "VAT 15", tax_name: "VAT", rate: 15 })).save();
    const items = [
      { name: "WATER", item_name: "Water", item_type: "Product", rate: 20, track_stock: 1, tax_template: "VAT 15", barcode: "750100" },
      { name: "DAYPASS", item_name: "Day pass", item_type: "Service", rate: 100 },
    ];
    for (const i of items) { const d = await loopar.newDocument("Item", i); d.__KEEP_NAME__ = true; await d.save(); }
    const opening = await loopar.newDocument("Stock Entry", { entry_type: "Adjustment", lines: [{ item: "WATER", qty: 50, unit_cost: 8 }] });
    await opening.save();
    await se.postStockEntry(await loopar.getDocument("Stock Entry", opening.name));
    profile = await pos.ensurePosProfile();
    const p = await loopar.getDocument("POS Profile", profile);
    p.max_discount_percent = 10;
    p.payment_methods = [{ payment_method: "Cash" }, { payment_method: "Card" }];
    await p.save();
  });
});
after(async () => { fiscal?.useFiscalProvider(undefined); await t?.teardown(); });

test("installing creates a register; selling needs an open shift", async () => {
  await t.run(async () => {
    assert.equal(profile, "Main Register");
    await assert.rejects(() => pos.checkout({ lines: [{ item: "DAYPASS" }], payments: [{ payment_method: "Cash", amount: 100 }] }), /Open a cash shift/);
    const shift = await pos.openShift({ pos_profile: profile, opening_cash: 500 });
    assert.equal(shift.status, "Open");
    assert.equal(shift.user, "Administrator");
    await assert.rejects(() => pos.openShift({ pos_profile: profile }), /already have an open shift/);
    const c = await pos.catalog(profile);
    assert.deepEqual(c.methods.map((m) => m.name), ["Cash", "Card"]);
    const water = c.items.find((i) => i.name === "WATER");
    assert.deepEqual([water.stock_qty, water.tax_rate, water.barcode], [50, 15, "750100"]);
    assert.equal(c.items.find((i) => i.name === "DAYPASS").stock_qty, null);
  });
});

let first;
test("a ticket is invoiced to the walk-in customer and paid, with change from cash", async () => {
  await t.run(async () => {
    // 2 × 20 + 15% = 46, + 100 = 146
    const sale = await pos.checkout({ lines: [{ item: "WATER", quantity: 2 }, { item: "DAYPASS" }], payments: [{ payment_method: "Cash", amount: 200 }] });
    first = sale.name;
    assert.deepEqual([sale.status, Number(sale.total), Number(sale.paid_amount), Number(sale.change_amount)], ["Paid", 146, 200, 54]);
    const inv = await loopar.getDocument("Invoice", sale.invoice);
    assert.equal(inv.status, "Paid");
    assert.equal(Number(inv.balance), 0);
    assert.equal((await loopar.db.getRow("Customer", inv.customer, ["customer_name"])).customer_name, pos.WALK_IN);
    const rows = await sale.payments;
    assert.equal(Number(rows[0].amount), 200);
    assert.equal(Number(await loopar.db.getValue("Payment", "amount", rows[0].payment)), 146, "the payment is the net of the change");
    assert.equal((await sl.balanceOf("WATER", "Main Warehouse")).qty, 48);
    assert.equal(await bal("1100 Cash"), 146);
  });
});

test("split payments, discounts within the register's limit", async () => {
  await t.run(async () => {
    await assert.rejects(() => pos.checkout({ lines: [{ item: "DAYPASS" }], discount_percent: 20, payments: [{ payment_method: "Cash", amount: 100 }] }), /highest discount/);
    await assert.rejects(() => pos.checkout({ lines: [{ item: "DAYPASS" }], payments: [{ payment_method: "Card", amount: 150 }] }), /Only cash gives change/);
    await assert.rejects(() => pos.checkout({ lines: [{ item: "DAYPASS" }], payments: [{ payment_method: "Cash", amount: 50 }] }), /do not cover/);
    await assert.rejects(() => pos.checkout({ lines: [{ item: "DAYPASS" }], payments: [{ payment_method: "Bank Transfer", amount: 100 }] }), /not accepted/);
    assert.equal(await q()("Sale").count({ c: "*" }).first().then((r) => Number(r.c)), 1, "failed tickets leave nothing");
    assert.equal(await q()("Invoice").count({ c: "*" }).first().then((r) => Number(r.c)), 1);

    const sale = await pos.checkout({ lines: [{ item: "DAYPASS", quantity: 2 }], discount_percent: 10, payments: [{ payment_method: "Card", amount: 100, reference: "AUTH1" }, { payment_method: "Cash", amount: 100 }] });
    assert.deepEqual([Number(sale.total), Number(sale.change_amount)], [180, 20]);
    const payments = await q()("Payment").where({ status: "Posted" }).orderBy("id");
    assert.deepEqual(payments.slice(1).map((p) => [p.payment_method, Number(p.amount)]), [["Card", 100], ["Cash", 80]]);
  });
});

test("not enough stock refuses the ticket", async () => {
  await t.run(async () => {
    await assert.rejects(() => pos.checkout({ lines: [{ item: "WATER", quantity: 100 }], payments: [{ payment_method: "Cash", amount: 5000 }] }), /Not enough WATER/);
    assert.equal((await sl.balanceOf("WATER", "Main Warehouse")).qty, 48);
  });
});

test("a cancelled ticket gives back the stock, the money and the invoice", async () => {
  await t.run(async () => {
    const sale = await pos.checkout({ lines: [{ item: "WATER", quantity: 3 }], payments: [{ payment_method: "Cash", amount: 69 }] });
    await assert.rejects(async () => pos.cancelSale(await loopar.getDocument("Sale", sale.name), {}), /reason/);
    await pos.cancelSale(await loopar.getDocument("Sale", sale.name), { reason: "Wrong item" });
    assert.equal(await loopar.db.getValue("Sale", "status", sale.name), "Cancelled");
    assert.equal(await loopar.db.getValue("Invoice", "status", sale.invoice), "Cancelled");
    assert.equal((await sl.balanceOf("WATER", "Main Warehouse")).qty, 48);
    const s = await loopar.getDocument("Sale", sale.name);
    s.notes = "x";
    await assert.rejects(() => s.save(), /cancel it to undo it/);
  });
});

test("closing the shift counts the money and posts the difference", async () => {
  await t.run(async () => {
    const shift = await pos.openShiftOf();
    const totals = await pos.shiftTotals(shift.name);
    assert.deepEqual([totals.sales_count, totals.sales_total], [2, 326]);
    // cash: 500 opening + 146 + 80
    assert.equal(totals.cash_expected, 726);
    await pos.closeShift(shift, { counted: { Cash: 720, Card: 100 } });
    const closed = await loopar.getDocument("Cash Shift", shift.name);
    assert.deepEqual([closed.status, Number(closed.cash_expected), Number(closed.cash_counted), Number(closed.cash_difference)], ["Closed", 726, 720, -6]);
    assert.equal(await bal("5400 Cash Over and Short"), 6);
    assert.equal(await bal("1100 Cash"), 226 - 6);
    await assert.rejects(async () => pos.cancelSale(await loopar.getDocument("Sale", first), { reason: "late" }), /shift of this sale is closed/);
    closed.closing_notes = "edit";
    await assert.rejects(() => closed.save(), /is closed/);
  });
});

test("the POS finds customers by name, email or tax ID", async () => {
  const { default: SaleController } = await erp("sales", "entities", "sale", "sale-controller.js");
  await t.run(async () => {
    const { createCustomer } = await erp("crm", "customers.js");
    const ana = await createCustomer({ customer_name: "Ana_Ríos", email: "ana@shop.test" });
    await loopar.db.updateRow("Customer", ana, { tax_id: "0801-99" });
    const find = async (q) => {
      const c = Object.create(SaleController.prototype);
      Object.defineProperty(c, "body", { value: { q } });
      return (await SaleController.prototype.actionCustomers.call(c)).customers.map((x) => x.customer_name);
    };
    assert.deepEqual(await find("ANA_"), ["Ana_Ríos"]);
    assert.deepEqual(await find("0801"), ["Ana_Ríos"]);
    assert.deepEqual(await find("a%"), []);
  });
});
