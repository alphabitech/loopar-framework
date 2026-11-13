import { test } from "node:test";
import assert from "node:assert/strict";
import { migrateDocument, migrateDocStructure, SEO_NODE_KEY } from "../../packages/loopar/core/global/element-migration.js";
import { pageSeoTags, resolvePageSeo, compactPageSeo, seoTexts, parseExtraTags } from "../../packages/loopar/core/global/page-seo.js";

const seoNode = (node, meta_name, options) => ({ node, element: "seo", data: { meta_name, options } });
const LEGACY = [
  seoNode("t", "title", "content=About us | Acme"),
  seoNode("d", "meta", "name=description\ncontent=Who we are, a=b"),
  seoNode("ot", "meta", "property=og:title\ncontent=About us | Acme"),
  seoNode("od", "meta", "property=og:description\ncontent=A different social text"),
  seoNode("k", "meta", "name=keywords\ncontent=a, b"),
  { node: "h", element: "heading", data: { text: "Hi", level: "h1" } },
];

test("seo nodes leave the canvas and become the page's seo settings", () => {
  const out = migrateDocument({ doc_structure: JSON.stringify(LEGACY) });
  assert.equal(out.changed, true);
  assert.deepEqual(JSON.parse(out.doc_structure).map((n) => n.element), ["heading"]);
  assert.deepEqual(JSON.parse(out.seo), {
    title: "About us | Acme",
    description: "Who we are, a=b",
    // Same as the title: the social title falls back to it.
    og_description: "A different social text",
    extra: "meta | name=keywords | content=a, b",
  });
});

test("seo values already set on the page win over the legacy nodes", () => {
  const out = migrateDocument({ doc_structure: JSON.stringify(LEGACY), seo: JSON.stringify({ title: "Kept" }) });
  assert.equal(JSON.parse(out.seo).title, "Kept");
});

test("translations of seo nodes move to the seo layer of each language", () => {
  const translations = JSON.stringify({ es: {
    t: { options: { value: "content=Nosotros | Acme", source: "x" } },
    h: { text: { value: "Hola", source: "y" } },
  } });
  const out = migrateDocument({ doc_structure: JSON.stringify(LEGACY), translations });
  const es = JSON.parse(out.translations).es;
  assert.equal(es.t, undefined);
  assert.equal(es[SEO_NODE_KEY].title.value, "Nosotros | Acme");
  assert.equal(es.h.text.value, "Hola");
  assert.equal(resolvePageSeo(out.seo, es).title, "Nosotros | Acme");
});

test("a robots noindex node becomes the page's noindex switch", () => {
  const out = migrateDocument({ doc_structure: JSON.stringify([seoNode("r", "meta", "name=robots\ncontent=noindex, nofollow")]) });
  assert.deepEqual(JSON.parse(out.seo), { noindex: 1 });
});

test("one-line seo options (name=… content=…) are read as intended", () => {
  const out = migrateDocument({ doc_structure: JSON.stringify([
    seoNode("d", "meta", "name=description content=Family-run floors, since 2010"),
    seoNode("o", "meta", "property=og:image content=https://acme.test/a.jpg"),
  ]) });
  assert.deepEqual(JSON.parse(out.seo), { description: "Family-run floors, since 2010", image: "https://acme.test/a.jpg" });
});

test("without a place to store them, seo nodes stay in the structure", () => {
  const [out, changed] = migrateDocStructure(LEGACY, { extractSeo: false });
  assert.equal(changed, false);
  assert.equal(out.filter((n) => n.element === "seo").length, 5);
});

test("head tags: social tags default to the title and description", () => {
  const tags = pageSeoTags({ title: "T", description: "D", image: "/img/share.jpg" }, { origin: "https://acme.test" });
  const meta = Object.fromEntries(tags.map((t) => [t.attrs.name || t.attrs.property, t.attrs.content]));
  assert.deepEqual(meta, {
    description: "D",
    "og:title": "T",
    "og:description": "D",
    "og:image": "https://acme.test/img/share.jpg",
    "twitter:card": "summary_large_image",
  });
  assert.equal(pageSeoTags({ noindex: 1 })[0].attrs.content, "noindex, nofollow");
  assert.deepEqual(pageSeoTags(""), []);
});

test("additional head tags: only meta and link, never scripts or handlers", () => {
  const tags = parseExtraTags([
    "meta | name=keywords | content=a, b",
    "link | rel=preconnect | href=https://cdn.test",
    "script | src=https://evil.test/x.js",
    "meta | name=x | onload=alert(1)",
    "link | rel=x | href=javascript:alert(1)",
  ].join("\n"));
  assert.deepEqual(tags.map((t) => t.tag + ":" + (t.attrs.name || t.attrs.rel)), ["meta:keywords", "link:preconnect"]);
});

test("seo is stored trimmed, without empty fields; its texts are translatable", () => {
  assert.equal(compactPageSeo({ title: "  A  ", description: "", noindex: 0 }), '{"title":"A"}');
  assert.equal(compactPageSeo({}), "");
  assert.deepEqual(seoTexts({ title: "A", image: "/x.jpg" }), [{ key: SEO_NODE_KEY, element: "seo", prop: "title", value: "A" }]);
});
