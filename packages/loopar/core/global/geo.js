'use strict';

import { isComputedField } from "./formula.js";

/**
 * Place of a record — shared by the server (which locates addresses) and the
 * client (which draws the map). An entity has a place by convention; there
 * is nothing to configure: two fields named `latitude` and `longitude`
 * (`lat` / `lng` / `lon` also count) hold where each record is.
 *
 * Its address, when it has one, is read from the fields named like the
 * parts of an address, in this order: the street (`address`, `street`,
 * `street_address`, `address_line_1`, or a field ending in `_address`),
 * `city`, `state` / `province`, `zip_code` / `postal_code` / `zip` and
 * `country`. With an address the coordinates fill themselves (a geocoder
 * turns it into a point); without one the point is placed by hand.
 *
 * Coordinates need six decimals (about 10 cm): declare them `decimal` with
 * `precision: 10, scale: 6` (the default scale of 2 would move every point
 * up to a kilometer).
 *
 * The rows of child tables don't count.
 */

const truthy = (value) => [1, "1", true, "true"].includes(value);

const LATITUDE = ["latitude", "lat"];
const LONGITUDE = ["longitude", "lng", "lon"];
const STREET = ["address", "street", "street_address", "address_line_1"];
// Named like an address without being a place.
const NOT_A_PLACE = /^(ip|email|e_mail|mac|web|wallet)_address$/;
const PARTS = [["city"], ["state", "province"], ["zip_code", "postal_code", "zip"], ["country"]];
const TEXT_ELEMENTS = new Set(["input", "textarea", "select", "connection"]);

function safeParse(text) {
  try { return JSON.parse(text); } catch { return []; }
}

/** Every field outside child tables, by name. */
function fieldsOf(structure, out = {}) {
  for (const el of structure || []) {
    if (el?.element === "form_table") continue;
    if (el?.data?.name && !(el.data.name in out)) out[el.data.name] = el;
    if (el?.elements) fieldsOf(el.elements, out);
  }
  return out;
}

/**
 * `{ latitude, longitude, address, editable }` for an entity structure, or
 * null when it has no coordinates. `address` lists the fields the address is
 * read from, in order (empty: no address); `editable` is false when a
 * coordinate is read-only (the point can't be moved by hand).
 */
export function geoFields(structure) {
  const parsed = typeof structure === "string" ? safeParse(structure) : structure;
  const fields = fieldsOf(Array.isArray(parsed) ? parsed : []);
  const named = (names) => names.find((name) => fields[name]?.element === "input") || null;

  const latitude = named(LATITUDE);
  const longitude = named(LONGITUDE);
  if (!latitude || !longitude) return null;

  const isText = (name) => !!fields[name] && TEXT_ELEMENTS.has(fields[name].element) && !truthy(fields[name].data.hidden);
  const street = STREET.find(isText)
    || Object.keys(fields).find((name) => name.endsWith("_address") && !NOT_A_PLACE.test(name) && isText(name))
    || null;
  const address = [street, ...PARTS.map((names) => names.find(isText) || null)].filter(Boolean);
  const readOnly = (name) => truthy(fields[name].data.readonly) || truthy(fields[name].data.read_only) || isComputedField(fields[name].data);

  return {
    latitude,
    longitude,
    // A street or a city is the least an address needs to be found.
    address: address.some((name) => name === street || name === "city") ? address : [],
    editable: !readOnly(latitude) && !readOnly(longitude),
  };
}

const filled = (value) => value !== null && value !== undefined && String(value).trim() !== "";

/** The address of `values` as one line ("12 Main St, Lynn, MA, 01901"), or "" without one. */
export function addressText(values, names) {
  return (names || []).map((name) => values?.[name]).filter(filled).map((part) => String(part).trim().replace(/\s+/g, " ")).join(", ");
}

/** `{ latitude, longitude }` as numbers when both are a real point on Earth, else null. */
export function coordinatesOf(latitude, longitude) {
  if (!filled(latitude) || !filled(longitude)) return null;
  const lat = Number(latitude), lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  // (0, 0) is what an empty pair of numeric columns reads as, not a place.
  if (lat === 0 && lng === 0) return null;
  return { latitude: lat, longitude: lng };
}

/** A coordinate as it is stored: six decimals (about 10 cm). */
export const roundCoordinate = (value) => Math.round(Number(value) * 1e6) / 1e6;

/** Whether two points are the same place as stored. */
export function samePlace(a, b) {
  if (!a || !b) return !a && !b;
  return roundCoordinate(a.latitude) === roundCoordinate(b.latitude) && roundCoordinate(a.longitude) === roundCoordinate(b.longitude);
}
