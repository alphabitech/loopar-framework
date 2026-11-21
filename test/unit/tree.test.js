import { test } from "node:test";
import assert from "node:assert/strict";
import { treeFields, buildTree, descendantsOf, canMoveUnder, withAncestors, flattenTree, branchTotals } from "../../packages/loopar/core/global/tree.js";

const connection = (name, options, extra = {}) => ({ element: "connection", data: { name, options, ...extra } });

test("treeFields: a connection to itself named parent / parent_*", () => {
  assert.deepEqual(treeFields([{ element: "row", elements: [connection("parent_account", "Account")] }], "Account"), { parent: "parent_account", editable: true });
  assert.deepEqual(treeFields(JSON.stringify([connection("parent", "Category", { readonly: 1 })]), "Category"), { parent: "parent", editable: false });
});

test("treeFields: other self links, other entities, hidden and child tables are not a tree", () => {
  assert.equal(treeFields([connection("reversal_of", "Journal Entry")], "Journal Entry"), null);
  assert.equal(treeFields([connection("parent_account", "Account")], "Item Group"), null);
  assert.equal(treeFields([connection("parent_group", "Group", { hidden: 1 })], "Group"), null);
  assert.equal(treeFields([{ element: "form_table", elements: [connection("parent_group", "Group")] }], "Group"), null);
  assert.equal(treeFields([connection("parenthood", "Group")], "Group"), null);
});

const rows = [
  { name: "A", p: null, n: 1 },
  { name: "B", p: "A", n: 2 },
  { name: "C", p: "B", n: 4 },
  { name: "D", p: "A", n: 8 },
  { name: "E", p: "missing", n: 16 },
];

test("buildTree: roots, children and records whose parent is not there", () => {
  const tree = buildTree(rows, "p");
  assert.deepEqual(tree.roots, ["A", "E"]);
  assert.deepEqual(tree.children, { A: ["B", "D"], B: ["C"] });
});

test("buildTree: a loop of parents is not lost", () => {
  const tree = buildTree([{ name: "X", p: "Y" }, { name: "Y", p: "X" }, { name: "Z", p: "Z" }], "p");
  const names = flattenTree(tree).map((r) => r.name).sort();
  assert.deepEqual(names, ["X", "Y", "Z"]);
});

test("descendantsOf / canMoveUnder", () => {
  const { children } = buildTree(rows, "p");
  assert.deepEqual([...descendantsOf(children, "A")].sort(), ["B", "C", "D"]);
  assert.equal(canMoveUnder(children, "A", "C"), false);
  assert.equal(canMoveUnder(children, "A", "A"), false);
  assert.equal(canMoveUnder(children, "C", "D"), true);
  assert.equal(canMoveUnder(children, "B", "E"), true);
});

test("withAncestors keeps the path to every match", () => {
  const { byName } = buildTree(rows, "p");
  assert.deepEqual([...withAncestors(byName, "p", ["C"])].sort(), ["A", "B", "C"]);
  assert.deepEqual([...withAncestors(byName, "p", ["E"])], ["E"]);
});

test("flattenTree: depth, collapsed branches and filtered records", () => {
  const tree = buildTree(rows, "p");
  assert.deepEqual(flattenTree(tree).map((r) => `${r.depth}${r.name}`), ["0A", "1B", "2C", "1D", "0E"]);
  assert.deepEqual(flattenTree(tree, { expanded: new Set(["A"]) }).map((r) => r.name), ["A", "B", "D", "E"]);
  const filtered = flattenTree(tree, { visible: new Set(["A", "D"]) });
  assert.deepEqual(filtered.map((r) => r.name), ["A", "D"]);
  assert.equal(filtered[0].hasChildren, true);
});

test("branchTotals: own value plus everything below", () => {
  const tree = buildTree(rows, "p");
  const totals = branchTotals(tree, ["n"]);
  assert.equal(totals.A.n, 15);
  assert.equal(totals.B.n, 6);
  assert.equal(totals.E.n, 16);
  assert.equal(branchTotals(tree, ["n"], new Set(["A", "D"])).A.n, 9);
});
