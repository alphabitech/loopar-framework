import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import knex from "knex";
import { Op } from "../../packages/db-env/database/core/shared/operators.js";
import { applyCondition } from "../../packages/db-env/database/core/knex/op-translator.js";

/** Op conditions → SQL, run against an in-memory SQLite table. */
let db;
before(async () => {
  db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await db.schema.createTable("t", (tb) => { tb.string("name"); tb.integer("qty"); tb.string("city"); });
  await db("t").insert([
    { name: "a", qty: 1, city: "Boston" },
    { name: "b", qty: 5, city: "Lynn" },
    { name: "c", qty: 10, city: null },
    { name: "d", qty: 15, city: "Boston" },
  ]);
});
after(async () => { await db?.destroy(); });

const names = async (condition) =>
  (await applyCondition(db("t").select("name"), condition).orderBy("name")).map((r) => r.name);

test("plain equality and implicit AND", async () => {
  assert.deepEqual(await names({ city: "Boston" }), ["a", "d"]);
  assert.deepEqual(await names({ city: "Boston", qty: 15 }), ["d"]);
});

test("comparison operators", async () => {
  assert.deepEqual(await names({ qty: { [Op.gt]: 5 } }), ["c", "d"]);
  assert.deepEqual(await names({ qty: { [Op.gte]: 5 } }), ["b", "c", "d"]);
  assert.deepEqual(await names({ qty: { [Op.lt]: 5 } }), ["a"]);
  assert.deepEqual(await names({ qty: { [Op.ne]: 5 } }), ["a", "c", "d"]);
});

test("in / notIn / like", async () => {
  assert.deepEqual(await names({ name: { [Op.in]: ["a", "c"] } }), ["a", "c"]);
  assert.deepEqual(await names({ name: { [Op.notIn]: ["a", "c"] } }), ["b", "d"]);
  assert.deepEqual(await names({ city: { [Op.like]: "Bos%" } }), ["a", "d"]);
});

test("null checks", async () => {
  assert.deepEqual(await names({ city: null }), ["c"]);
  assert.deepEqual(await names({ city: { [Op.ne]: null } }), ["a", "b", "d"]);
});

test("or / and / not", async () => {
  assert.deepEqual(await names({ [Op.or]: [{ name: "a" }, { qty: { [Op.gt]: 10 } }] }), ["a", "d"]);
  assert.deepEqual(await names({ [Op.and]: [{ city: "Boston" }, { qty: { [Op.lt]: 10 } }] }), ["a"]);
  assert.deepEqual(await names({ [Op.not]: { city: "Boston" } }), ["b"]);
});

test("Ops dispatch on the symbol description, not identity", async () => {
  // A second copy of the operator (duplicated module instance) still works.
  assert.deepEqual(await names({ name: { [Symbol("in")]: ["b"] } }), ["b"]);
});
