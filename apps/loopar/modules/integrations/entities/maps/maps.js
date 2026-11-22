'use strict';

import { BaseDocument, loopar } from 'loopar';

/** OpenFreeMap: OpenStreetMap vector tiles, free and without a key. */
const DEFAULT_STYLE = 'https://tiles.openfreemap.org/styles/liberty';

const TIMEOUT_MS = 5000;
// Public geocoders allow one request per second at most: lookups go one by one.
const SPACING_MS = 1100;
const CACHE_SIZE = 500;

let queue = Promise.resolve();
let lastRequest = 0;
const cache = new Map();

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs `task` after the previous lookup, leaving the geocoder its breathing time. */
function spaced(task) {
  const run = queue.then(async () => {
    const rest = lastRequest + SPACING_MS - Date.now();
    if (rest > 0) await wait(rest);
    try { return await task(); } finally { lastRequest = Date.now(); }
  });
  queue = run.catch(() => {});
  return run;
}

/**
 * Maps — the map every `map` element draws and the geocoder that turns an
 * address into a point (core/global/geo.js).
 * Usage: `(await loopar.getDocument('Maps')).geocode('12 Main St, Lynn, MA')`.
 * Without a geocoder URL nothing is looked up: points are placed by hand.
 */
export default class Maps extends BaseDocument {
  /** What a browser needs to draw a map: no key of the geocoder ever leaves the server. */
  publicConfig() {
    const style = String(this.map_style || '').trim() || DEFAULT_STYLE;
    return {
      style,
      style_dark: String(this.map_style_dark || '').trim() || style,
      geocoder: this.geocoderActive(),
    };
  }

  geocoderUrl() {
    return String(process.env.GEOCODER_URL || this.geocoder_url || '').trim();
  }

  geocoderActive() {
    return /^https?:\/\//i.test(this.geocoderUrl());
  }

  /**
   * The point of `address`: `{ latitude, longitude, label }`, or null when it
   * is not found, the geocoder is off, or it does not answer in time (a
   * lookup never fails what asked for it). Answers are remembered: the same
   * address is asked once.
   */
  async geocode(address) {
    const query = String(address || '').trim().replace(/\s+/g, ' ');
    if (!query || !this.geocoderActive()) return null;

    const base = this.geocoderUrl();
    const cacheKey = `${base}|${query.toLowerCase()}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey);

    const url = new URL(base);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');
    url.searchParams.set('limit', '1');
    const key = String(process.env.GEOCODER_KEY || this.geocoder_key || '').trim();
    if (key) url.searchParams.set('key', key);

    // The operator of the geocoder must be able to tell who is asking.
    const contact = String(this.geocoder_contact || '').trim();
    const site = loopar.tenantId || loopar.id || 'site';
    const agent = `Loopar/${site}${contact ? ` (${contact})` : ''}`;

    let found = null;
    try {
      found = await spaced(async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        try {
          const response = await fetch(url, { headers: { 'User-Agent': agent, Accept: 'application/json' }, signal: controller.signal });
          if (!response.ok) throw new Error(`geocoder answered ${response.status}`);
          const [first] = [].concat(await response.json());
          const latitude = Number(first?.lat), longitude = Number(first?.lon);
          if (!first || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
          return { latitude, longitude, label: String(first.display_name || query) };
        } finally {
          clearTimeout(timer);
        }
      });
    } catch (e) {
      console.warn(`[maps] lookup failed: ${e?.message || e}`);
      return null; // not remembered: the next save asks again
    }

    if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value);
    cache.set(cacheKey, found);
    return found;
  }
}
