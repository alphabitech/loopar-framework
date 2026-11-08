'use strict';

/*
 * The tenant's company (one per tenant, the `Company` single of the core
 * app): identity, contact, address, brand and regional defaults. Everything
 * that prints or sends "who we are" reads it from here.
 */

import chroma from 'chroma-js';
import { loopar } from '../loopar.js';
import { countryName as localizedCountryName } from './format.js';

export const COMPANY = 'Company';

/** Hex from a color_picker value ({"r","g","b","a"} JSON) or a hex string; null when unset. */
export function colorToHex(value) {
  if (!value) return null;
  try {
    if (typeof value === 'string' && value.trim().startsWith('#')) return chroma(value.trim()).hex();
    const c = typeof value === 'string' ? JSON.parse(value) : value;
    if (!c || typeof c !== 'object' || c.r == null) return null;
    return chroma.rgb(Number(c.r) || 0, Number(c.g) || 0, Number(c.b) || 0).hex();
  } catch {
    return null;
  }
}

/** Country name in the request's language ("HN" → "Honduras"). */
export function countryName(code) {
  return localizedCountryName(code);
}

/** Postal address as printed: street lines, "City, State ZIP", country. */
export function formatAddress(c = {}) {
  const cityLine = [[c.city, c.state].filter(Boolean).join(', '), c.postal_code].filter(Boolean).join(' ');
  return [String(c.address || '').trim(), cityLine, countryName(c.country)].filter(Boolean).join('\n');
}

/** The brand palette of the company for the theme generator, or null without a brand color. */
export function companyBrand(c) {
  const primary = colorToHex(c?.brand_color);
  if (!primary) return null;
  const accent = colorToHex(c?.accent_color);
  return { primary, ...(accent ? { accent } : {}) };
}

/**
 * The company record (null when the Company entity is not installed yet),
 * with `address_text`, `country_name` and `brand` derived.
 */
export async function getCompany() {
  if (!loopar.getRef(COMPANY, false)) return null;
  let row = null;
  try {
    row = await loopar.db.getDoc(COMPANY, null, ['*'], { isSingle: 1 });
  } catch (e) {
    console.warn('[company] unavailable:', e?.message);
    return null;
  }
  if (!row) return null;
  return {
    ...row,
    address_text: formatAddress(row),
    country_name: countryName(row.country),
    brand: companyBrand(row),
  };
}
