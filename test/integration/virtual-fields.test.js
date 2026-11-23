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
    assert.equal(by["1000 Assets"], 0);             // a group: the tree adds up its children
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
