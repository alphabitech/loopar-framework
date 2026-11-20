import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loopar } from "loopar";
import { bootTestTenant } from "../support/tenant.js";

/*
 * AlfraERP general ledger: a default chart on install, invoices posted in
 * the same transaction that issues them, reversals on cancel, manual
 * entries Draft → Posted, balances computed from the lines.
 */

let t, ledger, fiscal, customer;
const root = process.cwd();
const erp = (...p) => import(path.join(root, "apps", "erp", "modules", ...p));
const q = () => loopar.db.qx();

before(async () => {
  t = await bootTestTenant({ apps: ["erp"] });
  ledger = await erp("accounting", "ledger.js");
  fiscal = await erp("billing", "fiscal.js");
  fiscal.useFiscalProvider(null);
  await t.run(async () => {
    loopar.mail.send = async () => ({ ok: true });
    const { createCustomer } = await erp("crm", "customers.js");
    customer = await createCustomer({ customer_name: "Ledger Co", email: "ledger@co.test" });
    await (await loopar.newDocument("Tax Template", { name: "Std 15%", tax_name: "Tax", rate: 15 })).save();
    await (await loopar.newDocument("Item", { name: "GOODS", item_name: "Goods", rate: 100, tax_template: "Std 15%", item_type: "Product" })).save();
    await (await loopar.newDocument("Item", { name: "WORK", item_name: "Work", rate: 50, tax_template: "Std 15%", income_account: "4200 Services" })).save();
  });
});
after(async () => { fiscal?.useFiscalProvider(undefined); await t?.teardown(); });

const entryLines = async (entry) => (await q()("Journal Entry Line").where({ parent_document: "Journal Entry" })
  .whereIn("parent_id", q()("Journal Entry").select("id").where({ name: entry })))
  .map((l) => [l.account, Number(l.debit) || 0, Number(l.credit) || 0, l.party || null])
  .sort((a, b) => a[0].localeCompare(b[0]));

test("installing creates the default chart and points the settings at it", async () => {
  await t.run(async () => {
    assert.ok(await loopar.db.count("Account", "1300 Accounts Receivable"));
    assert.equal(await loopar.db.getValue("Account", "parent_account", "1300 Accounts Receivable"), "1000 Assets");
    const s = await ledger.accountingSettings();
    assert.equal(s.default_receivable_account, "1300 Accounts Receivable");
    assert.equal(s.default_income_account, "4100 Sales");
    assert.equal(s.post_billing, true);
  });
});

let invoiceName;
test("issuing an invoice posts receivable, net income per item and tax — balanced", async () => {
  await t.run(async () => {
    const inv = await loopar.newDocument("Invoice", { customer, discount_percent: 10, lines: [{ item: "GOODS", quantity: 2 }, { item: "WORK", quantity: 2 }] });
    await inv.save();
    const doc = await loopar.getDocument("Invoice", inv.name);
    await doc.issue();
    invoiceName = doc.name;
    // 200 + 100 = 300; discount 30; tax 15% of the discounted 270 = 40.5; total 310.5
    assert.equal(Number(doc.total), 310.5);
    const [entry] = await ledger.entriesOf("Invoice", doc.name);
    assert.ok(entry, "one posted entry");
    assert.deepEqual(await entryLines(entry.name), [
      ["1300 Accounts Receivable", 310.5, 0, customer],
      ["2200 Taxes Payable", 0, 40.5, null],
      ["4100 Sales", 0, 180, null],
      ["4200 Services", 0, 90, null],
    ]);
    const bal = await ledger.balances({ party: customer });
    assert.equal(bal["1300 Accounts Receivable"], 310.5);
  });
});

test("cancelling posts the reversal; the receivable nets to zero", async () => {
  await t.run(async () => {
    const doc = await loopar.getDocument("Invoice", invoiceName);
    await doc.cancel({ reason: "Test" });
    const entries = await q()("Journal Entry").where({ reference_document: "Invoice", reference_name: invoiceName }).orderBy("id");
    assert.deepEqual(entries.map((e) => [e.entry_type, e.status]), [["Invoice", "Cancelled"], ["Reversal", "Posted"]]);
    const bal = await ledger.balances({ party: customer });
    assert.equal(bal["1300 Accounts Receivable"] || 0, 0);
  });
});

test("a ledger failure rolls the issue back (no entry, still a draft, no fiscal number used)", async () => {
  let reserved = 0;
  fiscal.useFiscalProvider({ name: "T", async issue() { reserved++; await q()("Item").where({ name: "GOODS" }).update({ cost: reserved }); return { fiscal_number: `F-${reserved}` }; } });
  try {
    await t.run(async () => {
      const settings = await loopar.getDocument("Accounting Settings");
      settings.default_receivable_account = null;
      await settings.save();
      const inv = await loopar.newDocument("Invoice", { customer, lines: [{ item: "GOODS" }] });
      await inv.save();
      const doc = await loopar.getDocument("Invoice", inv.name);
      await assert.rejects(() => doc.issue(), /receivable account/);
      assert.equal(await loopar.db.getValue("Invoice", "status", inv.name), "Draft");
      assert.equal(await loopar.db.getValue("Invoice", "fiscal_number", inv.name), null);
      assert.equal(Number(await loopar.db.getValue("Item", "cost", "GOODS")) || 0, 0, "the provider's reservation was rolled back");
      assert.equal((await ledger.entriesOf("Invoice", inv.name)).length, 0);
      settings.default_receivable_account = "1300 Accounts Receivable";
      await settings.save();
    });
  } finally {
    fiscal.useFiscalProvider(null);
  }
});

test("manual entries: drafts may be unbalanced, posting requires balance, reversing cancels", async () => {
  await t.run(async () => {
    const je = await loopar.newDocument("Journal Entry", { remark: "Owner contribution", lines: [{ account: "1200 Bank", debit: 1000 }, { account: "3100 Owner's Equity", credit: 900 }] });
    await je.save();
    assert.equal(await loopar.db.getValue("Journal Entry", "status", je.name), "Draft");
    await assert.rejects(() => ledger.postDraft(je.name), /does not balance/);

    const fixed = await loopar.getDocument("Journal Entry", je.name);
    fixed.lines = [{ account: "1200 Bank", debit: 1000 }, { account: "3100 Owner's Equity", credit: 1000 }];
    await fixed.save();
    await ledger.postDraft(je.name);
    assert.equal((await ledger.balances({ accounts: ["1200 Bank"] }))["1200 Bank"], 1000);

    const posted = await loopar.getDocument("Journal Entry", je.name);
    posted.remark = "changed";
    await assert.rejects(() => posted.save(), /reverse it instead/);

    await ledger.reverseEntry(je.name);
    assert.equal((await ledger.balances({ accounts: ["1200 Bank"] }))["1200 Bank"], 0);

    const group = await loopar.newDocument("Journal Entry", { lines: [{ account: "1000 Assets", debit: 1 }, { account: "1200 Bank", credit: 1 }] });
    await assert.rejects(() => group.save(), /group account/);
  });
});

test("updating posts invoices issued before the ledger existed", async () => {
  await t.run(async () => {
    const inv = await loopar.newDocument("Invoice", { customer, lines: [{ item: "WORK" }] });
    await inv.save();
    const doc = await loopar.getDocument("Invoice", inv.name);
    await doc.issue();
    // As if issued before 1.3.0: no entry.
    const ids = q()("Journal Entry").select("id").where({ reference_name: inv.name });
    await q()("Journal Entry Line").where({ parent_document: "Journal Entry" }).whereIn("parent_id", ids).delete();
    await q()("Journal Entry").where({ reference_name: inv.name }).delete();

    const { default: Installer } = await import(path.join(root, "apps", "erp", "installer.js"));
    await new Installer({ app_name: "erp" }).install();
    const [entry] = await ledger.entriesOf("Invoice", inv.name);
    assert.ok(entry, "posted on update");
    assert.equal(Number(entry.total), 57.5);
  });
});

test("a document's entry is read only and can't be reversed by hand", async () => {
  await t.run(async () => {
    const [entry] = await ledger.entriesOf("Invoice", (await q()("Journal Entry").where({ entry_type: "Invoice", status: "Posted" }).first()).reference_name);
    await assert.rejects(() => ledger.reverseEntry(entry.name), /cancel that document/);
    const doc = await loopar.getDocument("Journal Entry", entry.name);
    assert.ok(doc.lockedFields().includes("lines"), "every field is locked");
  });
});
