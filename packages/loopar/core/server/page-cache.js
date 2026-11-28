'use strict';

import crypto from 'crypto';
import { KnexORM } from 'db-env';
import { loopar } from '../loopar.js';
import { shouldServeProduction } from './runtime-mode.js';
import { assetsVersion } from '../global/assets-version.js';
import { browserLanguage } from './i18n.js';

/**
 * Website page cache for visitors without a session (production only).
 *
 * A web page rendered for an anonymous visitor is the same for the next one,
 * so it is kept in memory and answered without running the controller or the
 * SSR again — the full HTML of a first visit and the JSON of a client
 * navigation (link click, hover prefetch) alike.
 *
 *   - Only navigations of the `web` workspace (a GET page visit, or the
 *     client's bodiless navigation POST), with no session cookie.
 *   - Only 200 responses that set no cookie.
 *   - Key: tenant, host, URL (query included), HTML vs JSON, language, the
 *     visitor's cookies (theme, carousel position…) and the public files stamp.
 *   - Any record written in the tenant (a page, a post, settings…) drops its
 *     pages; logs and analytics writes don't. Entries also expire after
 *     PAGE_CACHE_TTL_MS (default 60 s): content that changes with time
 *     (dated announcements, "latest" lists) is never older than that.
 *   - PAGE_CACHE_TTL_MS=0 turns it off. Responses carry X-Loopar-Cache.
 */
const TTL_MS = Number(process.env.PAGE_CACHE_TTL_MS ?? 60_000);
const MAX_BYTES = Number(process.env.PAGE_CACHE_MAX_MB ?? 64) * 1024 * 1024;
const MAX_ENTRY_BYTES = 2 * 1024 * 1024;

/** Writes that never change what a visitor sees. */
const SILENT_ENTITIES = /^(page view|document history|error log|error|debug.*|email queue|notification|job|jobs|session|audit.*|login.*|rate limit.*|spam.*|backup.*|form submission|contact message)$/i;

/** Cookies that never change the rendered page. */
const IGNORED_COOKIES = /^(csrf-token|_ga.*|_gid|_gat.*|_fbp|_gcl.*|__cf.*|cf_.*|umCatalog)$/;

const entries = new Map();          // key → { at, gen, status, type, body, bytes }
const generations = new Map();      // tenant → number
let totalBytes = 0;

const enabled = () => TTL_MS > 0 && shouldServeProduction();

function bump(tenant) {
  if (!tenant) return;
  generations.set(tenant, (generations.get(tenant) || 0) + 1);
}

for (const event of ['afterCreate', 'afterUpdate', 'afterDelete']) {
  KnexORM.on(event, ({ document } = {}) => {
    if (document && SILENT_ENTITIES.test(String(document))) return;
    try { bump(loopar.tenantId); } catch { /* outside a tenant */ }
  });
}

/** Drop every cached page of a tenant (or all of them). */
export function clearPageCache(tenant = null) {
  if (tenant) bump(tenant);
  else { entries.clear(); totalBytes = 0; }
}

function hasSession(req, tenant) {
  const cookies = req.cookies || {};
  const auth = loopar.auth;
  return !!(
    (auth?.tokenName && cookies[auth.tokenName]) ||
    (auth?.loggedCookieName && cookies[auth.loggedCookieName]) ||
    cookies[`loopar_${tenant}`]          // express-session (tenant-context.js)
  );
}

function hasBody(req) {
  const body = req.body;
  return body != null && typeof body === 'object' ? Object.keys(body).length > 0 : !!body;
}

function cookieFingerprint(req) {
  const cookies = req.cookies || {};
  const kept = Object.keys(cookies).filter(k => !IGNORED_COOKIES.test(k)).sort().map(k => `${k}=${cookies[k]}`);
  return kept.length ? crypto.createHash('sha1').update(kept.join(';')).digest('hex') : '';
}

function keyFor(req, tenant) {
  return [
    tenant,
    req.headers.host,
    req.originalUrl,
    req.__IS_AJAX__ ? 'json' : 'html',
    browserLanguage(req) || '',
    cookieFingerprint(req),
    assetsVersion(),
  ].join('|');
}

function evict(key) {
  const hit = entries.get(key);
  if (!hit) return;
  totalBytes -= hit.bytes;
  entries.delete(key);
}

function store(key, entry) {
  evict(key);
  // Oldest first (Map keeps insertion order): drop until the new entry fits.
  for (const oldest of entries.keys()) {
    if (totalBytes + entry.bytes <= MAX_BYTES) break;
    evict(oldest);
  }
  entries.set(key, entry);
  totalBytes += entry.bytes;
}

export function pageCacheMiddleware() {
  return (req, res, next) => {
    if (!enabled() || req.__ROUTE_MODE__ !== 'navigation' || req.__WORKSPACE_NAME__ !== 'web') return next();
    // A page visit is a GET; the client's navigation fetch (link click,
    // prefetch) is a POST that only names the workspace — a read as well.
    const isNavigationPost = req.method === 'POST' && req.__IS_AJAX__ && !hasBody(req);
    if (req.method !== 'GET' && !isNavigationPost) return next();
    const tenant = loopar.requestTenantId;
    if (!tenant || !loopar.__installed__ || hasSession(req, tenant)) return next();

    const key = keyFor(req, tenant);
    const gen = generations.get(tenant) || 0;
    const hit = entries.get(key);

    if (hit && hit.gen === gen && Date.now() - hit.at < TTL_MS) {
      // Most recently used goes last, so eviction drops the coldest pages.
      entries.delete(key); entries.set(key, hit);
      res.set('X-Loopar-Cache', 'HIT');
      if (hit.type) res.type(hit.type);
      return res.status(hit.status).send(hit.body);
    }
    if (hit) evict(key);

    res.set('X-Loopar-Cache', 'MISS');
    const send = res.send.bind(res);
    res.send = (body) => {
      try {
        // Why a page was not kept, for X-Loopar-Cache-Skip (no values, cookie names only).
        const cookies = res.getHeader('Set-Cookie');
        const skip =
          res.statusCode !== 200 ? `status ${res.statusCode}` :
          cookies ? `sets cookie ${[].concat(cookies).map(c => String(c).split('=')[0]).join(',')}` :
          !(typeof body === 'string' || Buffer.isBuffer(body)) ? `body ${typeof body}` :
          Buffer.byteLength(body) > MAX_ENTRY_BYTES ? 'too large' : null;
        if (skip) res.set('X-Loopar-Cache-Skip', skip);
        else store(key, { at: Date.now(), gen, status: 200, type: res.getHeader('Content-Type'), body, bytes: Buffer.byteLength(body) });
      } catch { /* never break the response */ }
      res.send = send;
      return send(body);
    };
    next();
  };
}
