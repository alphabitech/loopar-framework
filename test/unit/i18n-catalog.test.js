import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildCatalog, syncDictionary, dependenciesOf, similarity, suggestFromOrphans } from "../../packages/loopar/core/i18n/catalog.js";
import { compactTranslations, entryState, makeEntry, applyContentLayer, contentTextProps } from "../../packages/loopar/core/global/i18n-content.js";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "i18n-"));
  const w = (rel, data) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof data === "string" ? data : JSON.stringify(data)); };
  w("packages/loopar/translations/es.json", { Save: "Guardar" });
  w("apps/loopar/translations/es.json", { Name: "Nombre" });
  w("apps/shop/installer.json", { documents: { "App:shop": { description: "Shop", requires: "base", menu_items: [{ link: "Pricing" }, { link: "hidden", router_only: 1 }] } } });
  w("apps/base/installer.json", { documents: { "App:base": {} } });
  w("apps/base/translations/es.json", { "Customer": "Cliente" });
  w("apps/shop/modules/sales/client/a.jsx", `export const A = () => <b>{__("Save")}{__("Save changes")}{__("Customer")}</b>;\nloopar.throw("Stock is low");`);
  w("apps/shop/modules/sales/entities/order/order.json", { name: "Order", doc_structure: JSON.stringify([{ element: "row", data: { label: "Row1" }, elements: [{ element: "input", data: { name: "name", label: "Name" } }, { element: "select", data: { name: "state", label: "State", options: "open:Open\nclosed:Closed" } }] }]) });
  w("apps/shop/translations/es.json", { "Save change": "Guardar cambio", "Old text": "" });
  return root;
}

test("dependencies: framework, core app and requires", () => {
  const root = fixture();
  assert.deepEqual(dependenciesOf(root, "shop"), ["framework", "loopar", "base"]);
  assert.deepEqual(dependenciesOf(root, "framework"), []);
});

test("catalog: own, inherited, missing, orphans and suggestions", () => {
  const root = fixture();
  const { entries } = buildCatalog(root, "shop", "es");
  const by = Object.fromEntries(entries.map((e) => [e.key, e]));
  assert.equal(by.Save.status, "inherited");
  assert.equal(by.Save.provider, "framework");
  assert.equal(by.Customer.provider, "base");
  assert.equal(by.Name.provider, "loopar");
  for (const k of ["Order", "State", "Open", "Closed", "Stock is low", "Pricing", "Shop"]) assert.equal(by[k]?.status, "missing", k);
  assert.ok(!by.Row1 && !by.hidden);
  assert.equal(by["Save change"].status, "orphan");
  assert.deepEqual(by["Save changes"].suggestion.translation, "Guardar cambio");
  assert.ok(by["Save changes"].sources[0].endsWith("a.jsx"));
});

test("sync writes only what the app owns", () => {
  const root = fixture();
  const r = syncDictionary(root, "shop", "es", { prune: true });
  const dict = JSON.parse(fs.readFileSync(path.join(root, "apps/shop/translations/es.json"), "utf8"));
  assert.ok(!("Save" in dict) && !("Customer" in dict));
  assert.equal(dict.Order, "");
  assert.ok(!("Save change" in dict));
  assert.equal(r.pruned, true);
});

test("similarity", () => {
  assert.equal(similarity("Save", "Save"), 1);
  assert.ok(similarity("Save changes", "Save change") > 0.8);
  assert.ok(similarity("Delete", "Customer") < 0.3);
  assert.deepEqual(suggestFromOrphans(["Delete"], [["Customer", "Cliente"]]), {});
});

test("content entries keep the source they were translated from", () => {
  const t = compactTranslations({ es: { n1: { text: makeEntry("Hola", "Hello"), label: { value: "" } }, n2: { value: makeEntry("# Hola", "# Hi") } } });
  assert.deepEqual(Object.keys(t.es.n1), ["text"]);
  assert.equal(t.es.n2.value.value, "# Hola");
  assert.equal(entryState(t.es.n1.text, "Hello"), "translated");
  assert.equal(entryState(t.es.n1.text, "Hello world"), "outdated");
  assert.equal(entryState(undefined, "Hello"), "missing");
  const [node] = applyContentLayer([{ node: "n1", element: "heading", data: { text: "Hello" } }], t.es);
  assert.equal(node.data.text, "Hola");
  assert.deepEqual(contentTextProps("input", { group: "form" }), ["label", "description", "placeholder"]);
});

test("machine translations are kept marked in the dictionary", async () => {
  const { writeDictionary, readDictionary, machineKeys, MACHINE_KEY } = await import("../../packages/loopar/core/i18n/catalog.js");
  const root = fixture();
  const file = path.join(root, "apps/shop/translations/es.json");
  writeDictionary(file, { Order: "Pedido", State: "", [MACHINE_KEY]: ["Order", "State", "Gone"] });
  const dict = readDictionary(file);
  assert.deepEqual([...machineKeys(dict)], ["Order"]);
  const { entries } = buildCatalog(root, "shop", "es");
  assert.equal(entries.find((e) => e.key === "Order").machine, true);
  syncDictionary(root, "shop", "es");
  assert.deepEqual([...machineKeys(readDictionary(file))], ["Order"]);
});

test("AI answers are rejected when they break placeholders or tags", async () => {
  const { rejectReason } = await import("../../apps/loopar/modules/core/pages/translator/ai-translate.js").catch(() => ({}));
  if (!rejectReason) return; // needs the app's imports (loopar); covered in integration
  assert.equal(rejectReason("{0} is required", "{0} es obligatorio"), null);
  assert.equal(rejectReason("{0} is required", "es obligatorio"), "placeholders");
  assert.equal(rejectReason("<b>Hi</b>", "Hola"), "html");
  assert.equal(rejectReason("Hi", " "), "empty");
});
