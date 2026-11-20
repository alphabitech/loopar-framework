import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loopar } from "loopar";
import { bootTestTenant } from "../support/tenant.js";

/*
 * Units of measure: an item counts stock in its stock unit and is sold or
 * bought in others; lines convert to stock quantity, stock moves by it, and
 * prices follow the unit (its own price, else the stock-unit price × factor).
 */

let t, pos, sl, bills, customer, supplier;
const root = process.cwd();
const erp = (...p) => import(path.join(root, "apps", "erp", "modules", ...p));
const MAIN = "Main Warehouse";
const named = async (entity, values) => { const d = await loopar.newDocument(entity, values); d.__KEEP_NAME__ = true; await d.save(); return d; };
const stock = async () => (await sl.balanceOf("SODA", MAIN)).qty;

before(async () => {
  t = await bootTestTenant({ apps: ["erp"] });
  pos = await erp("sales", "pos.js");
  sl = await erp("stock", "stock-ledger.js");
  bills = await erp("purchasing", "bills.js");
  (await erp("billing", "fiscal.js")).useFiscalProvider(null);
  await t.run(async () => {
    loopar.mail.send = async () => ({ ok: true });
    const { createCustomer } = await erp("crm", "customers.js");
    customer = await createCustomer({ customer_name: "Units Co", email: "units@co.test" });
    const s = await loopar.newDocument("Supplier", { supplier_name: "Drinks Inc" }); await s.save(); supplier = s.name;
    await named("Unit of Measure", { name: "Six Pack", must_be_whole_number: 1 });
    await named("Item", {
      name: "SODA", item_name: "Soda can", item_type: "Product", track_stock: 1, unit: "Unit", rate: 2, cost: 1,
      purchase_unit: "Box", units: [{ unit: "Box", conversion_factor: 24 }, { unit: "Six Pack", conversion_factor: 6 }],
    });
    await loopar.newDocument("Item Price", { price_list: "Standard Selling", item: "SODA", unit: "Six Pack", rate: 10 }).then((d) => d.save());
  });
});
after(async () => { await t?.teardown(); });

test("installing creates the common units and the item's units are checked", async () => {
  await t.run(async () => {
    for (const u of ["Unit", "Box", "Hour", "Kg"]) assert.ok(await loopar.db.count("Unit of Measure", u), u);
    assert.equal(Number(await loopar.db.getValue("Unit of Measure", "must_be_whole_number", "Box")), 1);
    const bad = async (values) => named("Item", { name: `X${Math.random()}`, item_name: "X", item_type: "Product", unit: "Unit", ...values });
    await assert.rejects(() => bad({ units: [{ unit: "Unit", conversion_factor: 2 }] }), /stock unit/);
    await assert.rejects(() => bad({ units: [{ unit: "Box", conversion_factor: 0 }] }), /how many/);
    await assert.rejects(() => bad({ sales_unit: "Kg" }), /not one of the item's units/);
  });
});

test("a bill in boxes brings stock in units at the cost per unit", async () => {
  await t.run(async () => {
    const b = await loopar.newDocument("Purchase Invoice", { supplier, update_stock: 1, warehouse: MAIN, lines: [{ item: "SODA", quantity: 2 }] });
    await b.save();
    const bill = await loopar.getDocument("Purchase Invoice", b.name);
    const [l] = await bill.lines;
    // The purchase unit by default, priced from the item's cost × 24.
    assert.deepEqual([l.unit, Number(l.conversion_factor), Number(l.stock_qty), Number(l.rate)], ["Box", 24, 48, 24]);
    await bills.postBill(bill);
    assert.equal(await stock(), 48);
    assert.equal((await sl.balanceOf("SODA", MAIN)).rate, 1);
  });
});

test("selling in six packs uses their own price, in boxes the unit price × 24; stock leaves in units", async () => {
  await t.run(async () => {
    const inv = await loopar.newDocument("Invoice", { customer, warehouse: MAIN, lines: [
      { item: "SODA", quantity: 2, unit: "Six Pack" }, { item: "SODA", quantity: 1, unit: "Box" }, { item: "SODA", quantity: 3 },
    ] });
    await inv.save();
    const doc = await loopar.getDocument("Invoice", inv.name);
    assert.deepEqual((await doc.lines).map((l) => [l.unit, Number(l.stock_qty), Number(l.rate)]), [["Six Pack", 12, 10], ["Box", 24, 48], ["Unit", 3, 2]]);
    await doc.issue();
    assert.equal(await stock(), 48 - 39);

    await assert.rejects(() => loopar.newDocument("Invoice", { customer, lines: [{ item: "SODA", quantity: 1.5, unit: "Six Pack" }] }).then((d) => d.save()), /whole numbers/);
    await assert.rejects(() => loopar.newDocument("Invoice", { customer, lines: [{ item: "SODA", quantity: 1, unit: "Kg" }] }).then((d) => d.save()), /not counted in Kg/);
  });
});

test("a credit note returns the stock in the unit it was sold in", async () => {
  await t.run(async () => {
    const { makeCreditNote } = await erp("billing", "credit-notes.js");
    const inv = (await loopar.db.getAll("Invoice", ["name", "status"])).find((i) => i.status !== "Draft");
    const cn = await loopar.getDocument("Invoice", await makeCreditNote(inv.name, { reason: "Back" }));
    await cn.issue();
    assert.equal(await stock(), 48);
  });
});

test("the POS sells in the sales unit with its prices and stock", async () => {
  await t.run(async () => {
    const item = await loopar.getDocument("Item", "SODA");
    item.sales_unit = "Six Pack";
    await item.save();
    const profile = await pos.ensurePosProfile();
    await pos.openShift({ pos_profile: profile, opening_cash: 0 });
    const soda = (await pos.catalog(profile)).items.find((i) => i.name === "SODA");
    assert.deepEqual([soda.unit, soda.conversion_factor, soda.rate, soda.stock_qty], ["Six Pack", 6, 10, 8]);
    const sale = await pos.checkout({ lines: [{ item: "SODA", quantity: 2 }], payments: [{ payment_method: "Cash", amount: 20 }] });
    assert.equal(Number(sale.total), 20);
    assert.equal(await stock(), 36);
    const shift = await pos.openShiftOf();
    assert.deepEqual((await pos.shiftTotals(shift.name)).items.map((i) => [i.item, i.quantity]), [["SODA", 12]]);
  });
});
