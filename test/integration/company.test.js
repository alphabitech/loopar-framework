import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { loopar, getCompany, getLetterhead, colorToHex, formatAddress } from "loopar";
import { bootTestTenant, ADMIN } from "../support/tenant.js";
import { keepInstallersUntouched } from "../support/no-installer-writes.js";

/** Company: the tenant's identity, seeded by the installer and read by prints and themes. */
let t;
before(async () => { t = await bootTestTenant(); await t.run(keepInstallersUntouched); });
after(async () => { await t?.teardown(); });

const company = () => loopar.getDocument("Company");

test("the installer seeds Company; the language belongs to users, not System Settings", async () => {
  await t.run(async () => {
    const c = await getCompany();
    assert.equal(c.company_name, ADMIN.company);
    const settings = await loopar.getDocument("System Settings");
    assert.equal((await loopar.db.getValue("User", "language", "Administrator")) || "", "");
    assert.equal(settings.language, undefined);
  });
});

test("Company derives the printed address, the country name and the brand", async () => {
  await t.run(async () => {
    const c = await company();
    Object.assign(c, {
      legal_name: "Acme Holdings LLC", tax_id_label: "", tax_id: "12-3456789",
      address: "1 Main St\nSuite 2", city: "Boston", state: "MA", postal_code: "02128", country: "US",
      email: "Hello@Acme.test", website: "acme.test",
      brand_color: JSON.stringify({ r: 67, g: 56, b: 202, a: 1 }),
    });
    await c.save();

    const got = await getCompany();
    assert.equal(got.email, "hello@acme.test");
    assert.equal(got.website, "https://acme.test");
    assert.equal(got.tax_id_label, "Tax ID", "a tax id gets a generic label");
    assert.equal(got.address_text, "1 Main St\nSuite 2\nBoston, MA 02128\nUnited States");
    assert.equal(got.country_name, "United States");
    assert.deepEqual(got.brand, { primary: "#4338ca" });
  });
});

test("colors and addresses format without a Company", () => {
  assert.equal(colorToHex("#06B6D4"), "#06b6d4");
  assert.equal(colorToHex(JSON.stringify({ r: 0, g: 0, b: 0 })), "#000000");
  assert.equal(colorToHex(""), null);
  assert.equal(colorToHex("not a color"), null);
  assert.equal(formatAddress({ city: "Tegucigalpa", country: "HN" }), "Tegucigalpa\nHonduras");
});

test("the letterhead is the Company identity plus the letterhead's tagline and footer", async () => {
  await t.run(async () => {
    let lh = await getLetterhead();
    assert.equal(lh.company_name, ADMIN.company);
    assert.equal(lh.legal_name, "Acme Holdings LLC");
    assert.equal(lh.tax_id, "12-3456789");
    assert.match(lh.address, /Boston, MA 02128/);

    const doc = await loopar.newDocument("Letterhead", { name: "Main", tagline: "Since 2026", footer: "Thank you", is_default: 1 });
    await doc.save();
    lh = await getLetterhead();
    assert.equal(lh.tagline, "Since 2026");
    assert.equal(lh.footer, "Thank you");
    assert.equal(lh.company_name, ADMIN.company);
  });
});

test("a theme set to the Company brand is built from its color, and follows it", async () => {
  await t.run(async () => {
    const settings = await loopar.getDocument("System Settings");
    settings.theme = JSON.stringify({ theme: "company", darkMode: "auto" });
    await settings.save();
    const read = () => fs.readFileSync(loopar.makePath(loopar.tenantPath, "theme.css"), "utf8");
    const first = read();
    assert.ok(first.length > 100, "theme.css written");

    const c = await company();
    c.brand_color = JSON.stringify({ r: 220, g: 38, b: 38, a: 1 });
    await c.save();
    assert.notEqual(read(), first, "saving the brand rebuilds the theme");
  });
});

test("an update moves an old letterhead identity into an empty Company", async () => {
  await t.run(async () => {
    const q = () => loopar.db.qx();
    // State of a tenant before 7.4.3: identity columns on Letterhead, logo/country in System Settings.
    await q().schema.alterTable("Letterhead", (tb) => { tb.string("company_name"); tb.string("phone"); });
    await q()("Letterhead").where({ name: "Main" }).update({ company_name: "Old Name Inc", phone: "555-0100" });
    await q()("Document Single Values").insert({ name: "System Settings-country", document: "System Settings", field: "country", value: "Honduras" });

    const c = await company();
    c.phone = ""; c.country = "";
    await c.save();

    const { default: Installer } = await import(`${process.cwd()}/apps/loopar/installer.js`);
    await new Installer({ app_name: "loopar" }).install(true);

    const got = await getCompany();
    assert.equal(got.company_name, ADMIN.company, "filled fields are kept");
    assert.equal(got.phone, "555-0100");
    assert.equal(got.country, "HN");
    assert.equal(await q().schema.hasColumn("Letterhead", "company_name"), false, "old columns dropped");
    const left = await q()("Document Single Values").where({ document: "System Settings", field: "country" });
    assert.equal(left.length, 0);
  });
});
