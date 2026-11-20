import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loopar } from "loopar";
import { bootTestTenant } from "../support/tenant.js";

/*
 * Stock: a ledger of movements valued at moving average cost; receipts,
 * issues, transfers and adjustments post their journal entry; an issued
 * invoice delivers its stocked products and posts their cost; cancelling
 * puts everything back.
 */

let t, ledger, sl, se, fiscal, customer, supplier;
const root = process.cwd();
const erp = (...p) => import(path.join(root, "apps", "erp", "modules", ...p));
const q = () => loopar.db.qx();
const MAIN = "Main Warehouse";

before(async () => {
  t = await bootTestTenant({ apps: ["erp"] });
  ledger = await erp("accounting", "ledger.js");
  sl = await erp("stock", "stock-ledger.js");
  se = await erp("stock", "stock-entries.js");
  fiscal = await erp("billing", "fiscal.js");
  fiscal.useFiscalProvider(null);
  await t.run(async () => {
    loopar.mail.send = async () => ({ ok: true });
    const { createCustomer } = await erp("crm", "customers.js");
    customer = await createCustomer({ customer_name: "Buyer", email: "buyer@co.test" });
    const s = await loopar.newDocument("Supplier", { supplier_name: "Drinks Inc" });
    await s.save();
    supplier = s.name;
    await (await loopar.newDocument("Item", { name: "BOTTLE", item_name: "Bottle", item_type: "Product", rate: 45, track_stock: 1 })).save();
    await (await loopar.newDocument("Item", { name: "CLASS", item_name: "Class", item_type: "Service", rate: 100 })).save();
    const w = await loopar.newDocument("Warehouse", { name: "Store 2" });
    w.__KEEP_NAME__ = true;
    await w.save();
  });
});
after(async () => { fiscal?.useFiscalProvider(undefined); await t?.teardown(); });

const entry = async (values) => {
  const doc = await loopar.newDocument("Stock Entry", values);
  await doc.save();
  return await loopar.getDocument("Stock Entry", doc.name);
};
const post = async (values) => se.postStockEntry(await entry(values));
const item = (name = "BOTTLE") => loopar.db.getRow("Item", name, ["stock_qty", "valuation_rate"]);
const gl = async (reference) => {
  const ids = q()("Journal Entry").select("id").where({ reference_name: reference, status: "Posted" });
  return (await q()("Journal Entry Line").where({ parent_document: "Journal Entry" }).whereIn("parent_id", ids))
    .map((l) => [l.account, Number(l.debit) || 0, Number(l.credit) || 0]).sort((a, b) => a[0].localeCompare(b[0]) || a[1] - b[1]);
};

test("installing creates the main warehouse as the default", async () => {
  await t.run(async () => {
    assert.equal((await sl.stockSettings()).default_warehouse, MAIN);
  });
});

test("receipts add stock at moving average cost and post inventory against stock received not billed", async () => {
  await t.run(async () => {
    const r1 = await post({ entry_type: "Receipt", supplier, lines: [{ item: "BOTTLE", qty: 10, unit_cost: 20 }] });
    assert.deepEqual(await gl(r1.name), [["1400 Inventory", 200, 0], ["2150 Stock Received Not Billed", 0, 200]]);
    const supplierLine = await q()("Journal Entry Line").where({ account: "2150 Stock Received Not Billed" }).first();
    assert.equal(supplierLine.supplier, supplier);

    await post({ entry_type: "Receipt", supplier, lines: [{ item: "BOTTLE", qty: 10, unit_cost: 30 }] });
    assert.deepEqual(Object.values(await item()).map(Number), [20, 25]);
    assert.deepEqual(await sl.balanceOf("BOTTLE", MAIN), { qty: 20, value: 500, rate: 25 });
  });
});

let invoiceName;
test("an issued invoice delivers its stocked products and posts their cost", async () => {
  await t.run(async () => {
    const inv = await loopar.newDocument("Invoice", { customer, lines: [{ item: "BOTTLE", quantity: 4 }, { item: "CLASS", quantity: 1 }] });
    await inv.save();
    const doc = await loopar.getDocument("Invoice", inv.name);
    await doc.issue();
    invoiceName = doc.name;
    assert.equal(Number((await item()).stock_qty), 16);
    const lines = await gl(doc.name);
    assert.ok(lines.some((l) => l[0] === "5100 Cost of Goods Sold" && l[1] === 100));
    assert.ok(lines.some((l) => l[0] === "1400 Inventory" && l[2] === 100));
  });
});

test("not enough stock refuses to issue and moves nothing", async () => {
  await t.run(async () => {
    const draft = await entry({ entry_type: "Issue", lines: [{ item: "BOTTLE", qty: 30 }] });
    await assert.rejects(() => se.postStockEntry(draft), /Not enough BOTTLE/);
    assert.equal(await loopar.db.getValue("Stock Entry", "status", draft.name), "Draft");
    assert.equal(Number((await item()).stock_qty), 16);

    const inv = await loopar.newDocument("Invoice", { customer, lines: [{ item: "BOTTLE", quantity: 50 }] });
    await inv.save();
    const doc = await loopar.getDocument("Invoice", inv.name);
    await assert.rejects(() => doc.issue(), /Not enough BOTTLE/);
    assert.equal(await loopar.db.getValue("Invoice", "status", inv.name), "Draft", "the whole issue rolled back");
  });
});

test("transfers keep the value; adjustments post against stock adjustments", async () => {
  await t.run(async () => {
    const tr = await post({ entry_type: "Transfer", lines: [{ item: "BOTTLE", qty: 6, from_warehouse: MAIN, to_warehouse: "Store 2" }] });
    assert.deepEqual(await sl.balanceOf("BOTTLE", "Store 2"), { qty: 6, value: 150, rate: 25 });
    assert.equal((await sl.balanceOf("BOTTLE", MAIN)).qty, 10);
    assert.deepEqual(await gl(tr.name), [], "same inventory account: nothing to post");

    const adj = await post({ entry_type: "Adjustment", lines: [{ item: "BOTTLE", qty: -1, from_warehouse: MAIN }] });
    assert.deepEqual(await gl(adj.name), [["1400 Inventory", 0, 25], ["5300 Stock Adjustments", 25, 0]]);
    assert.equal(Number((await item()).stock_qty), 15);
  });
});

test("cancelling an invoice or an entry puts the stock back", async () => {
  await t.run(async () => {
    const doc = await loopar.getDocument("Invoice", invoiceName);
    await doc.cancel({ reason: "Returned" });
    assert.equal((await sl.balanceOf("BOTTLE", MAIN)).qty, 13);
    assert.equal(Number((await item()).stock_qty), 19);
    const cogs = (await ledger.balances({ accounts: ["5100 Cost of Goods Sold"] }))["5100 Cost of Goods Sold"] || 0;
    assert.equal(cogs, 0);

    const adj = (await q()("Stock Entry").where({ entry_type: "Adjustment" }).first()).name;
    await se.cancelStockEntry(await loopar.getDocument("Stock Entry", adj), { reason: "Found it" });
    assert.equal(Number((await item()).stock_qty), 20);
    assert.equal((await ledger.balances({ accounts: ["5300 Stock Adjustments"] }))["5300 Stock Adjustments"] || 0, 0);
  });
});

test("only items that track stock move; a posted entry is read only", async () => {
  await t.run(async () => {
    await assert.rejects(async () => se.postStockEntry(await entry({ entry_type: "Issue", lines: [{ item: "CLASS", qty: 1 }] })), /does not track stock/);
    const posted = await loopar.getDocument("Stock Entry", (await q()("Stock Entry").where({ status: "Posted" }).first()).name);
    posted.remark = "x";
    await assert.rejects(() => posted.save(), /cancel it to undo it/);
    const it = await loopar.getDocument("Item", "BOTTLE");
    it.stock_qty = 999;
    await it.save();
    assert.equal(Number((await item()).stock_qty), 20, "on hand comes from the ledger only");
  });
});

test("a backdated movement values again what came after it, and the journal follows", async () => {
  await t.run(async () => {
    await (await loopar.newDocument("Item", { name: "SODA", item_name: "Soda", item_type: "Product", rate: 30, track_stock: 1 })).save();
    const at = (posting_date, values) => post({ posting_date, ...values });
    await at("2026-01-10", { entry_type: "Receipt", supplier, lines: [{ item: "SODA", qty: 10, unit_cost: 10 }] });
    await at("2026-01-15", { entry_type: "Receipt", supplier, lines: [{ item: "SODA", qty: 10, unit_cost: 20 }] });
    const inv = await loopar.newDocument("Invoice", { customer, invoice_date: "2026-01-20", lines: [{ item: "SODA", quantity: 4 }] });
    await inv.save();
    const doc = await loopar.getDocument("Invoice", inv.name);
    await doc.issue();
    await at("2026-01-25", { entry_type: "Transfer", lines: [{ item: "SODA", qty: 6, from_warehouse: MAIN, to_warehouse: "Store 2" }] });
    assert.deepEqual(await sl.balanceOf("SODA", "Store 2"), { qty: 6, value: 90, rate: 15 });
    const cogs = async () => (await ledger.balances({ accounts: ["5100 Cost of Goods Sold"] }))["5100 Cost of Goods Sold"] || 0;
    const before = await cogs();

    // A receipt dated before the sale: the sale cost 4 × 20 instead of 4 × 15.
    await at("2026-01-12", { entry_type: "Receipt", supplier, lines: [{ item: "SODA", qty: 10, unit_cost: 30 }] });
    const sold = await q()("Stock Ledger Entry").where({ reference_name: doc.name, item: "SODA" }).first();
    assert.equal(Number(sold.value_change), -80);
    assert.equal(round(await cogs() - before), 20, "the invoice's cost is revalued");
    const reval = await q()("Journal Entry").where({ reference_document: "Invoice", reference_name: doc.name, status: "Posted" }).where("remark", "like", "Stock revaluation%").first();
    assert.equal(String(reval.posting_date).slice(0, 10), "2026-01-20", "on the invoice's own date");
    // The transfer carried the new cost to the other warehouse.
    assert.deepEqual(await sl.balanceOf("SODA", "Store 2"), { qty: 6, value: 120, rate: 20 });
    assert.deepEqual(await sl.balanceOf("SODA", MAIN), { qty: 20, value: 400, rate: 20 });
    assert.equal(Number((await item("SODA")).stock_qty), 26);
  });
});

test("a backdated issue that leaves a later point short is refused, and nothing moves", async () => {
  await t.run(async () => {
    const draft = await entry({ posting_date: "2026-01-16", entry_type: "Issue", lines: [{ item: "SODA", qty: 25 }] });
    await assert.rejects(() => se.postStockEntry(draft), /would leave SODA in Main Warehouse at -/);
    assert.deepEqual(await sl.balanceOf("SODA", MAIN), { qty: 20, value: 400, rate: 20 });
    assert.equal(await loopar.db.getValue("Stock Entry", "status", draft.name), "Draft");
  });
});

test("closed books refuse anything dated in them; a cancellation is posted today", async () => {
  await t.run(async () => {
    const settings = await loopar.getDocument("Accounting Settings");
    settings.lock_date = "2026-01-31";
    await settings.save();
    try {
      await assert.rejects(async () => se.postStockEntry(await entry({ posting_date: "2026-01-30", entry_type: "Receipt", supplier, lines: [{ item: "SODA", qty: 1, unit_cost: 1 }] })), /books are closed up to 2026-01-31/);
      const inv = await loopar.newDocument("Invoice", { customer, invoice_date: "2026-01-30", lines: [{ item: "CLASS", quantity: 1 }] });
      await inv.save();
      await assert.rejects(async () => (await loopar.getDocument("Invoice", inv.name)).issue(), /books are closed/);
      // A January invoice cancelled now: its reversal is dated today.
      const jan = (await q()("Invoice").where({ invoice_date: "2026-01-20" }).first()).name;
      await (await loopar.getDocument("Invoice", jan)).cancel({ reason: "Late return" });
      const reversals = await q()("Journal Entry").where({ reference_name: jan, entry_type: "Reversal" });
      assert.ok(reversals.length && reversals.every((r) => String(r.posting_date).slice(0, 10) > "2026-01-31"));
    } finally {
      settings.lock_date = null;
      await settings.save();
    }
  });
});

const round = (v) => Math.round(v * 100) / 100;
