import { test } from "node:test";
import assert from "node:assert/strict";
import { geoFields, addressText, coordinatesOf, roundCoordinate, samePlace } from "../../packages/loopar/core/global/geo.js";

const input = (name, extra = {}) => ({ element: "input", data: { name, ...extra } });

test("geoFields: latitude and longitude make a place; the address is read by name", () => {
  const geo = geoFields([{ element: "row", elements: [input("address"), input("city"), input("state"), input("zip_code"), input("latitude"), input("longitude")] }]);
  assert.deepEqual(geo, { latitude: "latitude", longitude: "longitude", address: ["address", "city", "state", "zip_code"], editable: true });
});

test("geoFields: short names, *_address streets, country as a select", () => {
  const geo = geoFields(JSON.stringify([input("project_address"), input("city"), { element: "select", data: { name: "country" } }, input("lat"), input("lng")]));
  assert.deepEqual(geo.address, ["project_address", "city", "country"]);
  assert.equal(geo.latitude, "lat");
  assert.equal(geo.longitude, "lng");
});

test("geoFields: no coordinates, no place; an ip address is not a street", () => {
  assert.equal(geoFields([input("address"), input("city")]), null);
  assert.equal(geoFields([input("latitude")]), null);
  assert.deepEqual(geoFields([input("ip_address"), input("state"), input("latitude"), input("longitude")]).address, []);
  assert.equal(geoFields([{ element: "form_table", elements: [input("latitude"), input("longitude")] }]), null);
});

test("geoFields: a read-only coordinate can't be moved", () => {
  assert.equal(geoFields([input("latitude", { readonly: 1 }), input("longitude")]).editable, false);
});

test("addressText joins the filled parts", () => {
  assert.equal(addressText({ address: " 12  Main St ", city: "Lynn", state: "", zip_code: "01901" }, ["address", "city", "state", "zip_code"]), "12 Main St, Lynn, 01901");
  assert.equal(addressText({}, ["address"]), "");
});

test("coordinatesOf: real points only", () => {
  assert.deepEqual(coordinatesOf("42.3601", "-71.0589"), { latitude: 42.3601, longitude: -71.0589 });
  assert.equal(coordinatesOf("", "-71"), null);
  assert.equal(coordinatesOf(0, 0), null);
  assert.equal(coordinatesOf(91, 10), null);
  assert.equal(coordinatesOf("abc", 10), null);
});

test("roundCoordinate / samePlace", () => {
  assert.equal(roundCoordinate(42.36012345678), 42.360123);
  assert.equal(samePlace({ latitude: 42.3601234, longitude: -71.05 }, { latitude: "42.3601231", longitude: "-71.05" }), true);
  assert.equal(samePlace({ latitude: 42.36, longitude: -71.05 }, { latitude: 42.37, longitude: -71.05 }), false);
  assert.equal(samePlace(null, null), true);
  assert.equal(samePlace(null, { latitude: 1, longitude: 1 }), false);
});
