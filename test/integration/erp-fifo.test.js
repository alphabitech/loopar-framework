import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loopar } from "loopar";
import { bootTestTenant } from "../support/tenant.js";

/*
 * FIFO valuation: what came in first leaves first, at its cost; a
 * backdated receipt changes which lots later issues took (and the journal
 * follows); cancelling puts the lots back; the method is fixed once stock
 * has moved.
 */

let t, sl, se, supplier;
const root = process.cwd();
const erp = (...p) => import(path.join(root, "apps", "erp", "modules", ...p));
const q = () => loopar.db.qx();
const MAIN = "Main Warehouse";

before(async () => {
  t = await bootTestTenant({ apps: ["erp"] });
  sl = await erp("stock", "stock-ledger.js");
  se = await erp("stock", "stock-entries.js");
  await t.run(async () => {
    const s = await loopar.newDocument("Supplier", { supplier_name: "Lots Inc" });
    await s.save();
    supplier = s.name;
    for (const [name, method] of [["OIL", "FIFO"], ["AVG", "Moving Average"]]) {
      const it = await loopar.newDocument("Item", { name, item_name: name, item_type: "Product", rate: 50, track_stock: 1, valuation_method: method });
      it.__KEEP_NAME__ = true;
      await it.save();
    }
  });
});
after(async () => { await t?.teardown(); });

const post = async (values) => {
  const doc = await loopar.newDocument("Stock Entry", values);
  await doc.save();
  return se.postStockEntry(await loopar.getDocument("Stock Entry", doc.name));
};
const queue = async (item) => JSON.parse((await q()("Stock Ledger Entry").where({ item, warehouse: MAIN })
  .orderBy([{ column: "posting_date", order: "desc" }, { column: "id", order: "desc" }]).first("stock_queue")).stock_queue);
const issueValue = async (name) => Number((await q()("Stock Ledger Entry").where({ reference_name: name, is_reversal: 0 }).first("value_change")).value_change);
const glOf = async (name) => {
  const ids = q()("Journal Entry").select("id").where({ reference_name: name, status: "Posted" });
  return (await q()("Journal Entry Line").where({ parent_document: "Journal Entry" }).whereIn("parent_id", ids))
    .reduce((s, l) => s + (l.account.startsWith("1400") ? Number(l.debit) - Number(l.credit) : 0), 0);
};

let issue;
test("issues take the oldest lots first, at their cost (moving average for comparison)", async () => {
  await t.run(async () => {
    for (const item of ["OIL", "AVG"]) {
      await post({ posting_date: "2026-03-01", entry_type: "Receipt", supplier, lines: [{ item, qty: 10, unit_cost: 10 }] });
      await post({ posting_date: "2026-03-02", entry_type: "Receipt", supplier, lines: [{ item, qty: 10, unit_cost: 20 }] });
    }
    issue = await post({ posting_date: "2026-03-05", entry_type: "Issue", lines: [{ item: "OIL", qty: 15 }] });
    const avg = await post({ posting_date: "2026-03-05", entry_type: "Issue", lines: [{ item: "AVG", qty: 15 }] });
    // FIFO: 10 × 10 + 5 × 20 = 200; moving average: 15 × 15 = 225.
    assert.equal(await issueValue(issue.name), -200);
    assert.equal(await issueValue(avg.name), -225);
    assert.deepEqual(await queue("OIL"), [[5, 20]]);
    assert.deepEqual(await sl.balanceOf("OIL", MAIN), { qty: 5, value: 100, rate: 20 });
    assert.equal(await glOf(issue.name), -200, "the issue's entry is the FIFO cost");
  });
});

test("a backdated receipt changes the lots a later issue took; the journal follows", async () => {
  await t.run(async () => {
    await post({ posting_date: "2026-02-20", entry_type: "Receipt", supplier, lines: [{ item: "OIL", qty: 5, unit_cost: 4 }] });
    // Now the issue takes 5 × 4 + 10 × 10 = 120; 10 × 20 stay.
    assert.equal(await issueValue(issue.name), -120);
    assert.deepEqual(await queue("OIL"), [[10, 20]]);
    assert.equal((await sl.balanceOf("OIL", MAIN)).value, 200);
    assert.equal(await glOf(issue.name), -120, "revalued on the issue's own date");
  });
});

test("cancelling an issue puts its lots back first; the method stays once stock moved", async () => {
  await t.run(async () => {
    await se.cancelStockEntry(await loopar.getDocument("Stock Entry", issue.name), { reason: "Mistake" });
    const bal = await sl.balanceOf("OIL", MAIN);
    assert.deepEqual([bal.qty, bal.value], [25, 320]);
    // What came back goes first, at the cost it left with (120 / 15 = 8).
    assert.deepEqual(await queue("OIL"), [[15, 8], [10, 20]]);
    const again = await post({ entry_type: "Issue", lines: [{ item: "OIL", qty: 5 }] });
    assert.equal(await issueValue(again.name), -40);

    const it = await loopar.getDocument("Item", "OIL");
    it.valuation_method = "Moving Average";
    await assert.rejects(() => it.save(), /valuation method stays/);
  });
});

test("an item that names no method keeps the one its stock first moved by", async () => {
  await t.run(async () => {
    const s = await loopar.getDocument("Stock Settings");
    s.valuation_method = "FIFO";
    await s.save();
    const it = await loopar.newDocument("Item", { name: "SALT", item_name: "Salt", item_type: "Product", rate: 5, track_stock: 1 });
    it.__KEEP_NAME__ = true;
    await it.save();
    await post({ posting_date: "2026-03-01", entry_type: "Receipt", supplier, lines: [{ item: "SALT", qty: 2, unit_cost: 1 }] });
    assert.equal(await loopar.db.getValue("Item", "valuation_method", "SALT"), "FIFO");
    s.valuation_method = "Moving Average";
    await s.save();
    assert.equal((await sl.valuationMethods(["SALT"])).SALT, "FIFO");
  });
});

test("an invoice delivers FIFO cost, its credit note brings it back, and stock agrees with the books", async () => {
  await t.run(async () => {
    (await erp("billing", "fiscal.js")).useFiscalProvider(null);
    loopar.mail.send = async () => ({ ok: true });
    const { createCustomer } = await erp("crm", "customers.js");
    const customer = await createCustomer({ customer_name: "Oil Buyer", email: "oil@co.test" });
    const before = await sl.balanceOf("OIL", MAIN);
    const inv = await loopar.newDocument("Invoice", { customer, warehouse: MAIN, lines: [{ item: "OIL", quantity: 12 }] });
    await inv.save();
    await (await loopar.getDocument("Invoice", inv.name)).issue();
    const out = await issueValue(inv.name);
    // 10 left of the lot at 8, then 2 at 20.
    assert.equal(out, -(10 * 8 + 2 * 20));
    const { makeCreditNote } = await erp("billing", "credit-notes.js");
    const cn = await loopar.getDocument("Invoice", await makeCreditNote(inv.name, { reason: "Back" }));
    await cn.issue();
    const after = await sl.balanceOf("OIL", MAIN);
    assert.deepEqual([after.qty, after.value], [before.qty, before.value]);
    const { stockAgainstLedger } = await erp("accounting", "reports.js");
    assert.deepEqual((await stockAgainstLedger({})).filter((l) => l.difference), [], "stock value equals the inventory accounts");
  });
});
