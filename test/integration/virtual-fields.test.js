import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loopar } from "loopar";
import { bootTestTenant } from "../support/tenant.js";

/*
 * Virtual fields (`data.virtual`): no column, computed on every read.
 * Account.balance is filled by the model (virtualValues) from the ledger.
 */

let t, ledger;
const root = process.cwd();
const erp = (...p) => import(path.join(root, "apps", "erp", "modules", ...p));

before(async () => {
  t = await bootTestTenant({ apps: ["erp"] });
  ledger = await erp("accounting", "ledger.js");
  await t.run(async () => {
    await loopar.db.withTransaction(async () => {
      await ledger.postEntry({ remark: "Capital", lines: [
        { account: "1100 Cash", debit: 500 },
        { account: "3100 Owner's Equity", credit: 500 },
      ] });
      await ledger.postEntry({ remark: "Deposit", lines: [
        { account: "1200 Bank", debit: 120 },
        { account: "1100 Cash", credit: 120 },
      ] });
    });
  });
});
after(async () => { await t?.teardown(); });

test("a virtual field keeps no column and is not a stored field of the ref", async () => {
  await t.run(async () => {
    const columns = [...(await loopar.db.getTableColumns("Account")).values()].map((c) => c.name);
    assert.ok(columns.includes("root_type"));
    assert.ok(!columns.includes("balance"));
    const ref = loopar.getRef("Account");
    assert.ok(!ref.__FIELDS__.includes("balance"));
    assert.deepEqual(ref.__VIRTUAL__, { balance: null });
    assert.ok(!("balance" in (ref.__FORMULAS__ || {})));
  });
});

test("tree rows carry the balance, signed by the account's nature", async () => {
  await t.run(async () => {
    const doc = await loopar.newDocument("Account");
    const { rows } = await doc.treeRows();
    const by = Object.fromEntries(rows.map((r) => [r.name, r.balance]));
    assert.equal(by["1100 Cash"], 380);
    assert.equal(by["1200 Bank"], 120);
    assert.equal(by["3100 Owner's Equity"], 500);   // credit nature reads positive
    assert.equal(by["1000 Assets"], 500);           // a group: the sum of the accounts under it
    assert.equal(by["3000 Equity"], 500);

    // The record's own form shows the same total.
    const assets = await loopar.getDocument("Account", "1000 Assets");
    assert.equal(Number((await assets.rawValues()).balance), 500);
  });
});

test("list rows and the record carry it too; saving never writes it", async () => {
  await t.run(async () => {
    const list = await (await loopar.newDocument("Account")).getList({ fields: ["name", "balance"], q: { name: "1100" }, rowsOnly: true });
    assert.equal(list.rows.find((r) => r.name === "1100 Cash")?.balance, 380);

    const cash = await loopar.getDocument("Account", "1100 Cash");
    assert.equal(Number((await cash.rawValues()).balance), 380);
    cash.description = "Petty cash";
    cash.balance = 999999;                       // ignored: never stored
    await cash.save();
    const again = await loopar.getDocument("Account", "1100 Cash");
    assert.equal(again.description, "Petty cash");
    assert.equal(Number((await again.values()).balance), 380);
  });
});

test("filtering or sorting by a virtual field is ignored, not an SQL error", async () => {
  await t.run(async () => {
    const doc = await loopar.newDocument("Account");
    const list = await doc.getList({ q: { balance: "380" }, sort: [{ field: "balance", dir: "desc" }], rowsOnly: true });
    assert.ok(list.rows.length > 1);
  });
});

test("static getters: one call for all the rows; one virtual can use another", async () => {
  await t.run(async () => {
    const doc = await loopar.newDocument("Account");
    const Account = doc.constructor;
    const ref = loopar.getRef("Account");
    const saved = ref.__VIRTUAL__;
    let calls = 0;
    const original = Account.getBalance;
    Account.getBalance = async function (rows) { calls++; return original.call(this, rows); };
    // A model virtual that reads another through its static, and a formula over a model virtual.
    Account.getDoubleBalance = async function (rows) {
      const balance = await this.getBalance(rows);
      return Object.fromEntries(Object.entries(balance).map(([name, value]) => [name, value * 2]));
    };
    ref.__VIRTUAL__ = { ...saved, double_balance: null, balance_plus_one: "balance + 1" };
    try {
      const { rows } = await doc.treeRows();
      assert.equal(calls, 1, "one call for the whole tree");
      const cash = rows.find((r) => r.name === "1100 Cash");
      assert.equal(cash.balance, 380);

      calls = 0;
      const list = await doc.getList({ fields: ["name", "double_balance", "balance_plus_one"], rowsOnly: true });
      const row = list.rows.find((r) => r.name === "1100 Cash") || (await doc.getList({ fields: ["name", "double_balance", "balance_plus_one"], q: { name: "1100" }, rowsOnly: true })).rows[0];
      assert.equal(row.double_balance, 760);
      assert.equal(row.balance_plus_one, 381, "the model virtual a formula reads is computed even if not asked");
    } finally {
      ref.__VIRTUAL__ = saved;
      Account.getBalance = original;
      delete Account.getDoubleBalance;
    }
  });
});

test("no static getter: the virtual field is null", async () => {
  await t.run(async () => {
    const ref = loopar.getRef("Account");
    const saved = ref.__VIRTUAL__;
    ref.__VIRTUAL__ = { ...saved, nothing_here: null };
    try {
      const rows = [{ name: "1100 Cash" }, { name: null }];
      await (await loopar.newDocument("Account")).applyVirtualValues(rows, ["nothing_here", "balance"]);
      assert.deepEqual(rows, [{ name: "1100 Cash", nothing_here: null, balance: 380 }, { name: null, nothing_here: null, balance: null }]);
    } finally {
      ref.__VIRTUAL__ = saved;
    }
  });
});

test("self: in a form the getter gets the document and may answer its value directly", async () => {
  await t.run(async () => {
    const Account = (await loopar.newDocument("Account")).constructor;
    const original = Account.getBalance;
    const seen = [];
    Account.getBalance = async function (rows, self) {
      seen.push(self ? `self:${self.name}` : `rows:${rows.length}`);
      if (self) return 42;                       // the record's value
      return original.call(this, rows);          // the map, for lists
    };
    try {
      const cash = await loopar.getDocument("Account", "1100 Cash");
      assert.equal(Number((await cash.rawValues()).balance), 42);
      const { rows } = await (await loopar.newDocument("Account")).treeRows();
      assert.equal(rows.find((r) => r.name === "1100 Cash").balance, 380);
      assert.deepEqual(seen.map((s) => s.split(":")[0]), ["self", "rows"]);
      assert.equal(seen[0], "self:1100 Cash");
    } finally {
      Account.getBalance = original;
    }
  });
});
