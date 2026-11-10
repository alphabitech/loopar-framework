import { test } from "node:test";
import assert from "node:assert/strict";
import { migrateDocStructure } from "../../packages/loopar/core/global/element-migration.js";

test("title becomes heading: first is h1, the rest h2, display size kept", () => {
  const [out, changed] = migrateDocStructure([
    { element: "section", elements: [
      { element: "title", node: "a", data: { text: "One" } },
      { element: "title", node: "b", data: { text: "Two", size: "3xl" } },
    ] },
  ]);
  assert.equal(changed, true);
  const [a, b] = out[0].elements;
  assert.deepEqual([a.element, a.data.level, a.data.size], ["heading", "h1", "display"]);
  assert.deepEqual([b.element, b.data.level, b.data.size], ["heading", "h2", "display"]);
});

test("an existing h1 heading keeps the page's only h1", () => {
  const [out] = migrateDocStructure([
    { element: "heading", data: { level: "h1" } },
    { element: "title", data: {} },
  ]);
  assert.equal(out[1].data.level, "h2");
});

test("removed elements are merged or dropped; children survive", () => {
  const [out] = migrateDocStructure(JSON.stringify([
    { element: "container", data: { class: "x" }, elements: [{ element: "fragment", data: {}, elements: [{ element: "paragraph", data: { text: "p" } }] }] },
    { element: "slider", data: {} },
    { element: "banner_image", data: { full_height: 1 }, elements: [{ element: "image", data: {} }] },
    { element: "direct-preview", data: { entity: "Customer", action: "list", entity_name: "C-1" } },
    { element: "html_block", data: { value: "<b>x</b>" } },
    { element: "stripe", data: {} },
    { element: "stripe_embebed", data: {} },
    { element: "banner", data: { alling: "start" } },
  ]));
  const nodes = JSON.parse(out);
  assert.equal(typeof out, "string");
  assert.deepEqual(nodes.map((n) => n.element), ["div", "carousel", "div", "entity", "markdown", "banner"]);
  assert.match(nodes[0].data.class, /^x min-h-page/);
  assert.equal(nodes[0].elements[0].element, "div");
  assert.equal(nodes[0].elements[0].elements[0].element, "paragraph");
  assert.match(nodes[2].data.class, /p-2 lg:p-4 h-\[calc/);
  assert.equal(nodes[2].data.full_height, undefined);
  assert.deepEqual(nodes[3].data, { action: "list", name: "Customer" });
  assert.equal(nodes[4].data.value, "<b>x</b>");
  assert.deepEqual(nodes[5].data, { align: "start" });
});

test("nothing to migrate returns the same value, unchanged", () => {
  const input = JSON.stringify([{ element: "heading", data: { level: "h2" } }]);
  const [out, changed] = migrateDocStructure(input);
  assert.equal(changed, false);
  assert.equal(out, input);
});

test("subtitle, text_block_icon and card are merged into heading, feature_card and panel", () => {
  const [out] = migrateDocStructure([
    { element: "subtitle", node: "s", data: { text: "Sub" } },
    { element: "text_block_icon", node: "t", data: { icon: "Star", title: "T", text: "x", orientation: "Vertical", text_size: "xl", icon_size: "xl" } },
    { element: "card", node: "c", data: { label: "Card", description: "d" }, elements: [{ element: "paragraph", data: {} }] },
  ]);
  assert.deepEqual([out[0].element, out[0].data.level, out[0].data.size], ["heading", "h3", "xl"]);
  assert.equal(out[1].element, "feature_card");
  assert.deepEqual(out[1].data, { icon: "Star", title: "T", text: "x", variant: "plain", align: "center", icon_size: "xl" });
  assert.equal(out[2].element, "panel");
  assert.equal(out[2].data.title, "Card");
  assert.equal(out[2].data.bg_color, "card");
  assert.equal(out[2].elements[0].element, "paragraph");
});

test("translations follow renamed props", async () => {
  const { migrateDocument } = await import("../../packages/loopar/core/global/element-migration.js");
  const r = migrateDocument({
    doc_structure: JSON.stringify([
      { element: "text_block_icon", node: "t", data: { title: "Hi" } },
      { element: "card", node: "c", data: { label: "Card" } },
    ]),
    translations: JSON.stringify({ es: { t: { title: { value: "Hola" }, text: { value: "x" } }, c: { label: { value: "Tarjeta" } } } }),
  });
  const t = JSON.parse(r.translations);
  assert.deepEqual(t.es.t, { title: { value: "Hola" }, text: { value: "x" } });
  assert.deepEqual(t.es.c, { label: { value: "Tarjeta" }, title: { value: "Tarjeta" } });
});

test("vocabulary: generic → div, label → title, subtitle → description, with translations", async () => {
  const { migrateDocument } = await import("../../packages/loopar/core/global/element-migration.js");
  const r = migrateDocument({
    doc_structure: [
      { element: "generic", node: "g", data: { tag: "p", inner_text: "Hi", label: "Generic1" } },
      { element: "feature_card", node: "f", data: { label: "Fast", text: "x" } },
      { element: "review", node: "r", data: { subtitle: "Sub" } },
      { element: "form", node: "fo", data: { succes_message: "Thanks" } },
    ],
    translations: { es: { g: { inner_text: { value: "Hola" } }, f: { label: { value: "Rápido" } } } },
  });
  const [g, f, rv, fo] = r.doc_structure;
  assert.deepEqual([g.element, g.data], ["div", { tag: "p", text: "Hi" }]);
  assert.deepEqual(f.data, { title: "Fast", text: "x" });
  assert.deepEqual(rv.data, { description: "Sub" });
  assert.deepEqual(fo.data, { success_message: "Thanks" });
  assert.deepEqual(r.translations.es, { g: { text: { value: "Hola" } }, f: { title: { value: "Rápido" } } });
});

test("filler labels are dropped except for menu_content entries", () => {
  const [out] = migrateDocStructure([
    { element: "row", data: { label: "Row1" }, elements: [{ element: "col", data: { label: "Col1" } }] },
    { element: "menu_content", data: {}, elements: [{ element: "markdown", data: { label: "Intro", value: "#" } }, { element: "div", data: { label: "API" } }] },
    { element: "section", data: { label: "Contact" } },
  ]);
  assert.deepEqual(out[0].data, {});
  assert.deepEqual(out[0].elements[0].data, {});
  assert.equal(out[1].elements[0].data.label, "Intro");
  assert.equal(out[1].elements[1].data.label, "API");
  assert.equal(out[2].data.label, "Contact");
});

test("legacy field flags fold into write_policy; removed form elements are merged", () => {
  const [out, , , conversions] = migrateDocStructure([
    { element: "input", data: { name: "name", set_only_time: 1 } },
    { element: "input", data: { name: "total", readonly: 1 } },
    { element: "input", data: { name: "x", readonly: 1, write_policy: "system" } },
    { element: "currency", data: { name: "amount" } },
    { element: "padding", data: { name: "col_padding" } },
    { element: "text_editor", data: { name: "body" } },
    { element: "radio_item", data: {} },
  ]);
  assert.deepEqual(out[0].data, { name: "name", write_policy: "create_only" });
  assert.deepEqual(out[1].data, { name: "total", write_policy: "display_only" });
  assert.deepEqual(out[2].data, { name: "x", write_policy: "system" });
  assert.deepEqual([out[3].element, out[3].data.format], ["input", "currency"]);
  assert.deepEqual([out[4].element, out[4].data.options.split("\n").length], ["select", 10]);
  assert.equal(out[5].element, "markdown_input");
  assert.equal(out.length, 6);
  assert.deepEqual(conversions, [{ field: "body", kind: "quill-delta" }]);
});

test("Quill delta values become markdown", async () => {
  const { quillDeltaToMarkdown } = await import("../../packages/loopar/core/global/element-migration.js");
  const md = quillDeltaToMarkdown(JSON.stringify({ ops: [
    { insert: "Title" }, { insert: "\n", attributes: { header: 2 } },
    { insert: "Hello " }, { insert: "world", attributes: { bold: true } }, { insert: "\n" },
    { insert: "one" }, { insert: "\n", attributes: { list: "bullet" } },
  ] }));
  assert.equal(md, "## Title\nHello **world**\n- one");
  assert.equal(quillDeltaToMarkdown("plain text"), "plain text");
});

test("bootstrap classes become their Tailwind equivalent", () => {
  const [out] = migrateDocStructure([
    { element: "paragraph", data: { class: "text-muted font-size-lg max-w-2xl mx-auto" } },
    { element: "heading", data: { class: "display-4 mb-4 lead" } },
    { element: "paragraph", data: { class: "text-muted-foreground mb-0" } },
  ]);
  assert.equal(out[0].data.class, "text-muted-foreground text-lg max-w-2xl mx-auto");
  assert.equal(out[1].data.class, "mb-4");
  assert.equal(out[2].data.class, "text-muted-foreground mb-0");
});

test("selects bound to an entity become connections", () => {
  const [out] = migrateDocStructure([
    { element: "select", data: { name: "customer", options: "Customer", options_source: "entity" } },
    { element: "select", data: { name: "site", options: "Site" } },
    { element: "select", data: { name: "status", options: "Open\nClosed", options_source: "static" } },
    { element: "select", data: { name: "only", options: "Yes", options_source: "static" } },
  ]);
  assert.deepEqual(out.map((n) => n.element), ["connection", "connection", "select", "select"]);
  assert.ok(out.every((n) => !("options_source" in n.data)));
});
