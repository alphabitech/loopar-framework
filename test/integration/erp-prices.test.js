import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loopar } from "loopar";
import { bootTestTenant } from "../support/tenant.js";

/*
 * Catalog: price lists (default, the customer's or supplier's, the
 * register's) price lines that have no rate, by quantity and date; item
 * groups give their items the accounts they leave empty and the POS its tabs.
 */

let t, pos, ledger, customer, vip;
const root = process.cwd();
const erp = (...p) => import(path.join(root, "apps", "erp", "modules", ...p));
const q = () => loopar.db.qx();
const day = (offset) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);
const price = (values) => loopar.newDocument("Item Price", values).then((d) => d.save());
const named = async (entity, values) => { const d = await loopar.newDocument(entity, values); d.__KEEP_NAME__ = true; await d.save(); return d; };
const linesOf = async (doc) => (await doc.lines).map((l) => [l.item, Number(l.quantity), Number(l.rate), l.price_list_rate == null || l.price_list_rate === "" ? null : Number(l.price_list_rate)]);

before(async () => {
  t = await bootTestTenant({ apps: ["erp"] });
  pos = await erp("sales", "pos.js");
  ledger = await erp("accounting", "ledger.js");
  (await erp("billing", "fiscal.js")).useFiscalProvider(null);
  await t.run(async () => {
    loopar.mail.send = async () => ({ ok: true });
    const { createCustomer } = await erp("crm", "customers.js");
    customer = await createCustomer({ customer_name: "Retail Co", email: "retail@co.test" });
    vip = await createCustomer({ customer_name: "VIP Co", email: "vip@co.test" });
    await named("Item Group", { name: "Services" });
    await named("Item Group", { name: "Training", parent_item_group: "Services", income_account: "4200 Services", sort_order: 1 });
    await named("Item", { name: "CLASS", item_name: "Class", item_type: "Service", item_group: "Training", rate: 100 });
    await named("Item", { name: "MAT", item_name: "Mat rent", item_type: "Service", rate: 10 });
    await price({ price_list: "Standard Selling", item: "CLASS", rate: 90 });
    await price({ price_list: "Standard Selling", item: "CLASS", rate: 80, min_quantity: 10 });
    await price({ price_list: "Standard Selling", item: "CLASS", rate: 50, valid_from: day(10) }); // not yet
    await named("Price List", { name: "VIP", price_list_type: "Selling" });
    await price({ price_list: "VIP", item: "CLASS", rate: 70 });
    const c = await loopar.getDocument("Customer", vip);
    c.price_list = "VIP";
    await c.save();
  });
});
after(async () => { await t?.teardown(); });

test("installing creates the standard price lists as the defaults", async () => {
  await t.run(async () => {
    const s = await loopar.getDocument("Stock Settings");
    assert.deepEqual([s.default_selling_price_list, s.default_buying_price_list], ["Standard Selling", "Standard Buying"]);
    assert.equal(await loopar.db.getValue("Price List", "price_list_type", "Standard Buying"), "Buying");
  });
});

test("lines without a rate take the list price for their quantity and date; others keep theirs", async () => {
  await t.run(async () => {
    const inv = await loopar.newDocument("Invoice", { customer, lines: [
      { item: "CLASS", quantity: 2 }, { item: "CLASS", quantity: 12 }, { item: "MAT", quantity: 1 }, { item: "CLASS", quantity: 1, rate: 95 },
    ] });
    await inv.save();
    const doc = await loopar.getDocument("Invoice", inv.name);
    assert.equal(doc.price_list, "Standard Selling");
    assert.deepEqual(await linesOf(doc), [["CLASS", 2, 90, 90], ["CLASS", 12, 80, 80], ["MAT", 1, 10, null], ["CLASS", 1, 95, null]]);

    // The customer's own list wins over the default.
    const v = await loopar.newDocument("Quote", { customer: vip, lines: [{ item: "CLASS", quantity: 1 }] });
    await v.save();
    const quote = await loopar.getDocument("Quote", v.name);
    assert.deepEqual([quote.price_list, Number((await quote.lines)[0].rate)], ["VIP", 70]);

    await assert.rejects(() => loopar.newDocument("Invoice", { customer, price_list: "Standard Buying", lines: [{ item: "CLASS", quantity: 1 }] }).then((d) => d.save()), /buying price list/);
  });
});

test("bills take the supplier's buying list, else the default one", async () => {
  await t.run(async () => {
    await price({ price_list: "Standard Buying", item: "MAT", rate: 6 });
    await named("Price List", { name: "Mats Inc prices", price_list_type: "Buying" });
    await price({ price_list: "Mats Inc prices", item: "MAT", rate: 5 });
    const s1 = await loopar.newDocument("Supplier", { supplier_name: "Anyone" }); await s1.save();
    const s2 = await loopar.newDocument("Supplier", { supplier_name: "Mats Inc", price_list: "Mats Inc prices" }); await s2.save();
    const rates = [];
    for (const supplier of [s1.name, s2.name]) {
      const b = await loopar.newDocument("Purchase Invoice", { supplier, lines: [{ item: "MAT", quantity: 3 }] });
      await b.save();
      const bill = await loopar.getDocument("Purchase Invoice", b.name);
      rates.push([bill.price_list, Number((await bill.lines)[0].rate)]);
    }
    assert.deepEqual(rates, [["Standard Buying", 6], ["Mats Inc prices", 5]]);
  });
});

test("an item without an income account books to its group's (or a group above)", async () => {
  await t.run(async () => {
    await assert.rejects(() => loopar.getDocument("Item Group", "Services").then((g) => { g.parent_item_group = "Training"; return g.save(); }), /circle/);
    const inv = await loopar.newDocument("Invoice", { customer, lines: [{ item: "CLASS", quantity: 1 }, { item: "MAT", quantity: 1 }] });
    await inv.save();
    const doc = await loopar.getDocument("Invoice", inv.name);
    await doc.issue();
    const [entry] = await ledger.entriesOf("Invoice", doc.name);
    const credits = Object.fromEntries((await q()("Journal Entry Line").where({ parent_document: "Journal Entry" })
      .whereIn("parent_id", q()("Journal Entry").select("id").where({ name: entry.name })).where("credit", ">", 0))
      .map((l) => [l.account, Number(l.credit)]));
    assert.deepEqual(credits, { "4200 Services": 90, "4100 Sales": 10 });
  });
});

test("the POS shows group tabs and list prices, and charges the price for the quantity", async () => {
  await t.run(async () => {
    const profile = await pos.ensurePosProfile();
    await pos.openShift({ pos_profile: profile, opening_cash: 0 });
    const cat = await pos.catalog(profile);
    assert.deepEqual(cat.groups, ["Training"]);
    const cls = cat.items.find((i) => i.name === "CLASS");
    assert.deepEqual([cls.item_group, cls.rate, cls.item_rate, cls.prices], ["Training", 90, 100, [[10, 80], [0, 90]]]);
    assert.deepEqual((await pos.prices({ customer: vip })).prices.CLASS, [[0, 70]]);

    const sale = await pos.checkout({ lines: [{ item: "CLASS", quantity: 10 }], payments: [{ payment_method: "Cash", amount: 800 }] });
    assert.equal(Number(sale.total), 800);
    const vipSale = await pos.checkout({ customer: vip, lines: [{ item: "CLASS", quantity: 1 }], payments: [{ payment_method: "Cash", amount: 70 }] });
    assert.equal(Number(vipSale.total), 70);
    assert.equal(await loopar.db.getValue("Invoice", "price_list", vipSale.invoice), "VIP");
  });
});
