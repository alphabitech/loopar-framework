'use strict';

/**
 * Internal networks — "this traffic is our own people".
 *
 * Two registries, both fed by authenticated requests (router middleware):
 *
 *  - TENANT: any logged-in user of a tenant teaches that tenant the network
 *    the request came from. Anonymous views from it are dropped on every
 *    site/domain of THAT tenant, from any browser.
 *  - OPERATOR (global): only sessions of a platform operator — Administrator,
 *    or a user who can open Tenant Manager, on a controlPlane tenant — feed
 *    it. EVERY tenant checks it, so the operator browsing client sites
 *    anonymously (deploy checks, reviews) is never recorded. Client users
 *    can never write here.
 *
 * - IPv4: the full address. IPv6: the /64 prefix, because macOS/iOS rotate
 *   their temporary IPv6 addresses (~daily) inside the same /64.
 * - Stored hashed (same salt as Page View ip_hash) — no raw IPs on disk.
 * - TTL: an entry not re-seen in TTL_DAYS stops counting, so a dynamic
 *   residential IP handed to someone else expires on its own.
 * - Files (sites/ = gitignored runtime state):
 *     sites/<tenant>/.internal-networks.json   { <netHash>: lastSeen }
 *     sites/.operator-networks.json            { nets: {..}, ips: {<ipHash>: lastSeen} }
 *   `ips` keeps the exact ip_hash too, so the cleanup can find past rows of
 *   the operator in every tenant. Writes are throttled (new entry, or
 *   lastSeen older than TOUCH_MS).
 * - In-memory cache; single process on purpose (instances:1).
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { loopar } from '../loopar.js';
import { tenant as tenantBuilder } from '../../bin/tenant/tenant-builder.js';

const TTL_DAYS = 30;
const TTL_MS = TTL_DAYS * 24 * 60 * 60 * 1000;
const TOUCH_MS = 60 * 60 * 1000;
const TENANT_FILE = '.internal-networks.json';
const OPERATOR_FILE = '.operator-networks.json';
const OPERATOR = '__operator__';

let cachedSalt = null;

/** Salt for every analytics hash (ip_hash, network hash). */
export function trackingSalt() {
  if (cachedSalt) return cachedSalt;
  if (process.env.TRACKING_SALT) return (cachedSalt = process.env.TRACKING_SALT);
  try {
    const dir = path.join(loopar.pathRoot, 'sites');
    const file = path.join(dir, '.tracking-salt');
    if (fs.existsSync(file)) cachedSalt = fs.readFileSync(file, 'utf8').trim();
    if (!cachedSalt) {
      cachedSalt = randomBytes(32).toString('hex');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, cachedSalt, { mode: 0o600 });
    }
  } catch (error) {
    console.warn(['Can not persist tracking salt, using ephemeral one', error]);
    cachedSalt = randomBytes(32).toString('hex');
  }
  return cachedSalt;
}

/** Client IP as seen behind the reverse proxy. */
export function clientIp(req = {}) {
  return (req.headers?.['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || req.socket?.remoteAddress || '';
}

/** Page View `ip_hash` of an IP (exact address). */
export function ipHash(ip) {
  return createHash('sha256').update(String(ip || '') + trackingSalt()).digest('hex').slice(0, 16);
}

function expandIPv6(ip) {
  const [head, tail = ''] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  if (!ip.includes('::')) return h;
  return [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
}

/** Network identity of an IP: IPv4 as-is, IPv6 reduced to its /64. */
export function networkKey(ip) {
  let v = String(ip || '').trim().toLowerCase();
  if (!v) return '';
  v = v.replace(/^\[|\]$/g, '').split('%')[0];
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return mapped[1];
  if (!v.includes(':')) return v;
  return expandIPv6(v).slice(0, 4).map(x => (parseInt(x, 16) || 0).toString(16)).join(':') + '::/64';
}

export function networkHash(ip) {
  const key = networkKey(ip);
  if (!key) return '';
  return createHash('sha256').update('net:' + key + trackingSalt()).digest('hex').slice(0, 24);
}

/* ---------------------------------------------------------------- stores */

const stores = new Map();

function tenantKey() {
  return loopar.requestTenantId || '__core__';
}

function storeFile(key) {
  const sites = path.join(loopar.pathRoot, 'sites');
  if (key === OPERATOR) return path.join(sites, OPERATOR_FILE);
  return key === '__core__' ? path.join(sites, TENANT_FILE) : path.join(sites, key, TENANT_FILE);
}

function load(key) {
  if (stores.has(key)) return stores.get(key);
  let data = {};
  try {
    const file = storeFile(key);
    if (fs.existsSync(file)) data = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch (error) {
    console.warn(['Can not read internal networks', error]);
  }
  if (key === OPERATOR) data = { nets: data.nets || {}, ips: data.ips || {} };
  stores.set(key, data);
  return data;
}

function persist(key, data) {
  try {
    const file = storeFile(key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
  } catch (error) {
    console.warn(['Can not persist internal networks', error]);
  }
}

/** Touch `hash` in map; returns true when the map changed enough to persist. */
function touch(map, hash, now) {
  const prev = map[hash];
  if (prev && now - prev < TOUCH_MS) return false;
  map[hash] = now;
  for (const [h, seen] of Object.entries(map)) {
    if (now - seen > TTL_MS) delete map[h];
  }
  return true;
}

const fresh = (seen, now = Date.now()) => !!seen && now - seen <= TTL_MS;

/* -------------------------------------------------------------- operator */

const cpCache = new Map();
const CP_TTL_MS = 60 * 1000;

/** Is `name` a control-plane tenant? (config read cached for a minute) */
export function isControlPlaneTenant(name = loopar.requestTenantId) {
  if (!name) return false;
  const hit = cpCache.get(name);
  if (hit && Date.now() - hit.at < CP_TTL_MS) return hit.value;
  let value = false;
  try { value = tenantBuilder.isControlPlane(name); } catch { value = false; }
  cpCache.set(name, { value, at: Date.now() });
  return value;
}

/* ------------------------------------------------------------------ API */

/**
 * Record the request's network as internal. Called on authenticated
 * requests; `operator: true` also feeds the global operator registry.
 */
export function learnInternalNetwork(ip, { operator = false } = {}) {
  const net = networkHash(ip);
  if (!net) return;
  const now = Date.now();

  const key = tenantKey();
  const data = load(key);
  if (touch(data, net, now)) persist(key, data);

  if (operator) {
    const op = load(OPERATOR);
    const a = touch(op.nets, net, now);
    const b = touch(op.ips, ipHash(ip), now);
    if (a || b) persist(OPERATOR, op);
  }
}

/** Anonymous traffic from this IP is our own (tenant or operator network). */
export function isInternalNetwork(ip) {
  const net = networkHash(ip);
  if (!net) return false;
  const now = Date.now();
  return fresh(load(tenantKey())[net], now) || fresh(load(OPERATOR).nets[net], now);
}

/** Exact ip_hashes the operator connected from (for retroactive cleanup). */
export function operatorIpHashes() {
  const now = Date.now();
  return Object.entries(load(OPERATOR).ips).filter(([, s]) => fresh(s, now)).map(([h]) => h);
}
