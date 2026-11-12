import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loopar } from "loopar";
import { bootTestTenant } from "../support/tenant.js";
import { installSiteFromTemplate, readAppHeader, isTemplateHeader } from "../../packages/loopar/apps/core/modules/system/forms/installer/template.js";

/**
 * blank-site: the template a cloud workspace gets when the customer picked
 * none. Installing it must leave a working website (active web app + pages).
 */
const SITE = `zz-blank-test-${process.pid}-site`;
const siteDir = path.join(process.cwd(), "apps", SITE);

let t;
before(async () => { t = await bootTestTenant(); });
after(async () => {
  await t?.teardown();
  fs.rmSync(siteDir, { recursive: true, force: true });
});

test("blank-site is a template without requirements", () => {
  const header = readAppHeader("blank-site");
  assert.ok(isTemplateHeader(header));
  assert.equal(header.requires, undefined);
});

test("a site made from it becomes the workspace's website, with its three pages", async () => {
  await t.run(async () => {
    await installSiteFromTemplate("blank-site", SITE);

    assert.equal(loopar.webApp?.name, SITE);
    assert.deepEqual(loopar.webApp.menu_items.map(m => [m.link, m.page]), [
      ["Home", "Site Home"], ["About", "Site About"], ["Contact", "Site Contact"],
    ]);
    for (const page of ["Site Home", "Site About", "Site Contact"]) {
      assert.equal(loopar.getRef(page)?.__APP__, SITE, `${page} belongs to the site`);
    }
    // The copy is a regular app of this tenant, not a template any more.
    assert.equal(readAppHeader(SITE).is_template, undefined);
    assert.equal(readAppHeader(SITE).owner_tenant, loopar.tenantId);
  });
});
