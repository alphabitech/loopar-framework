import { test } from "node:test";
import assert from "node:assert/strict";
import { noWebsitePage, noWebsiteStatus } from "../../packages/loopar/core/server/no-website-page.js";

test("no website: the root is fine (200), any other public path is a 404", () => {
  assert.equal(noWebsiteStatus("/"), 200);
  assert.equal(noWebsiteStatus(""), 200);
  assert.equal(noWebsiteStatus("/about"), 404);
});

test("no website: the page names the host, leads to the desk and stays out of search engines", () => {
  const html = noWebsitePage({ host: "acme.loopar.build" });
  assert.match(html, /no website yet/i);
  assert.match(html, /acme\.loopar\.build/);
  assert.match(html, /href="\/desk"/);
  assert.match(html, /noindex/);
});

test("no website: the host is escaped", () => {
  assert.doesNotMatch(noWebsitePage({ host: '"><script>x</script>' }), /<script>/);
});
