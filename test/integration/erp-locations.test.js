import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { loopar } from "loopar";
import { bootTestTenant } from "../support/tenant.js";

/*
 * Where the work happens: a Customer Address. A quote and a project link
 * one (and print its address), an approved quote opens its project there,
 * and a shift of that project is worked at the same place.
 */

let t, customer, other, place;
const q = () => loopar.db.qx();

before(async () => {
  t = await bootTestTenant({ apps: ["erp"] });
  await t.run(async () => {
    const { createCustomer } = await loopar.api("Customer");
    customer = await createCustomer({ customer_name: "Acme", email: "ap@acme.test", address: "1 Main St", city: "Boston", state: "MA", zip_code: "02110" });
    other = await createCustomer({ customer_name: "Other Co" });
    const { createAddress } = await loopar.api("Customer Address");
    place = await createAddress({ customer, title: "Warehouse", address: "9 Dock Rd", city: "Lynn", state: "MA", zip_code: "01901", geofence_radius_m: 80 });
  });
});
after(async () => { await t?.teardown(); });

test("a quote's service location is one of its customer's places and fills the address it prints", async () => {
  await t.run(async () => {
    const quote = await loopar.newDocument("Quote", { customer, address: place, lines: [{ description: "Work", quantity: 1, rate: 100 }] });
    await quote.save();
    const row = await q()("Quote").where({ name: quote.name }).first();
    assert.deepEqual([row.address, row.project_address, row.city, row.zip_code], [place, "9 Dock Rd", "Lynn", "01901"]);

    const foreign = await loopar.newDocument("Quote", { customer: other, address: place, lines: [{ description: "Work", quantity: 1, rate: 100 }] });
    await assert.rejects(() => foreign.save(), /belongs to another customer/);
  });
});

test("the project of a quote is at the quote's location; a typed address becomes a place of the customer, once", async () => {
  await t.run(async () => {
    const linked = await loopar.newDocument("Quote", { customer, address: place, lines: [{ description: "Work", quantity: 1, rate: 100 }] });
    await linked.save();
    const project = await (await loopar.getDocument("Quote", linked.name)).openProject();
    const row = await q()("Project").where({ name: project }).first();
    assert.deepEqual([row.location, row.address, row.city], [place, "9 Dock Rd", "Lynn"]);

    const quotes = [];
    for (let i = 0; i < 2; i++) {
      const typed = await loopar.newDocument("Quote", { customer, project_address: "22 Elm St", city: "Salem", zip_code: "01970", lines: [{ description: "Work", quantity: 1, rate: 100 }] });
      await typed.save();
      quotes.push(await (await loopar.getDocument("Quote", typed.name)).openProject());
    }
    const locations = (await q()("Project").whereIn("name", quotes).select("location")).map((p) => p.location);
    assert.equal(locations[0], locations[1], "the same street is the same place");
    const made = await q()("Customer Address").where({ name: locations[0] }).first();
    assert.deepEqual([made.customer, made.address_type, made.title, made.city], [customer, "Service Location", "22 Elm St, Salem", "Salem"]);
    assert.equal(Number((await q()("Customer Address").where({ customer }).count({ c: "*" }).first()).c), 2);

    // A shift of the project is worked at the project's location.
    const position = await loopar.newDocument("Job Position", { name: "Installer", active: 1 });
    position.__KEEP_NAME__ = true;
    await position.save();
    const shift = await loopar.newDocument("Shift", { job_position: "Installer", project, shift_date: "2026-12-01", start_time: "08:00:00", end_time: "16:00:00", headcount: 1 });
    await shift.save();
    const stored = await q()("Shift").where({ name: shift.name }).first();
    assert.deepEqual([stored.location, stored.customer], [place, customer]);
  });
});
