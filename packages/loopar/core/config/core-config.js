'use strict';

/**
 * Core config — server-global settings (port, mode, shared cache, Caddy;
 * nothing per-tenant — the control plane is a tenant flag, see tenant-builder), read from config/core.json at the
 * project root. Bare-mode safe (fs + JSON only) so CLI/PM2 can read it
 * pre-framework; every getter falls back to process.env and then a sane
 * default, so a missing core.json never breaks boot.
 */

import fs from 'fs';
import path from 'pathe';

const CONFIG_PATH = path.join(process.cwd(), 'config', 'core.json');

let _cache = null;

function load() {
  if (_cache) return _cache;
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) || {};
  } catch {
    file = {};
  }
  _cache = file;
  return file;
}

/** Force a re-read on next access (after writing config/core.json). */
export function reloadCoreConfig() { _cache = null; }

/** Merge a patch into config/core.json and persist it (one-level merge for redis/caddy/cloud). */
export function setCoreConfig(patch = {}) {
  const current = load();
  const next = { ...current, ...patch };
  for (const k of ['redis', 'caddy', 'cloud']) {
    if (patch[k] && typeof patch[k] === 'object') {
      next[k] = { ...(current[k] || {}), ...patch[k] };
    }
  }
  if (!fs.existsSync(path.dirname(CONFIG_PATH))) fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + '\n', 'utf8');
  _cache = next;
  return next;
}

/** Set the core mode (development | production) and persist it. */
export function setCoreMode(mode) {
  const m = String(mode).toLowerCase() === 'production' ? 'production' : 'development';
  return setCoreConfig({ nodeEnv: m });
}

const pick = (v, ...fallbacks) => (v !== undefined && v !== null ? v : fallbacks.find(f => f !== undefined && f !== null));

/** Core HTTP port — every tenant domain routes here via Caddy. */
export function corePort() {
  return Number(pick(load().port, process.env.CORE_PORT, process.env.PORT, 3000));
}

/** Core mode — Vite (development) vs prebuilt dist (production), for ALL tenants. */
export function coreEnv() {
  return pick(load().nodeEnv, process.env.NODE_ENV, 'development');
}

/**
 * Debugger collector (requests, SQL, logs, errors — see core/debug). On by
 * default in development, off in production unless `"debug": true` in
 * config/core.json (or LOOPAR_DEBUG=1). Read at boot: restart to apply.
 */
export function debugEnabled() {
  const v = pick(load().debug, process.env.LOOPAR_DEBUG);
  if (v === undefined || v === null || v === '') return coreEnv() !== 'production';
  return v === true || v === 'true' || v === 1 || v === '1';
}

/** Bind address. */
export function coreHost() {
  return pick(load().host, process.env.HOST, '0.0.0.0');
}

/** Shared cache (Redis) config — one store, keyed per tenant. */
export function redisConfig() {
  const r = load().redis || {};
  const host = pick(r.host, process.env.REDIS_HOST, null);
  return {
    host,
    port: Number(pick(r.port, process.env.REDIS_PORT, 6379)),
    password: pick(r.password, process.env.REDIS_PASSWORD, null),
    ttlPermissions: Number(pick(r.ttlPermissions, process.env.REDIS_TTL_PERMISSIONS, 300)),
  };
}

export function caddyAcmeEmail() {
  return pick(load().caddy?.acmeEmail, process.env.CADDY_ACME_EMAIL, null);
}

export function socketCorsOrigin() {
  return pick(load().socketCorsOrigin, process.env.SOCKET_CORS_ORIGIN, null);
}

export function cloudConfig() {
  const c = load().cloud || {};
  return {
    verifierUrl: pick(c.verifierUrl, process.env.CLOUD_VERIFIER_URL, null),
    claimSecret: pick(c.claimSecret, process.env.CLOUD_CLAIM_SECRET, null),
  };
}

/**
 * Flattened env map injected at spawn (PM2) — the single point that turns
 * config/core.json into the process.env.* the runtime reads.
 */
export function coreEnvVars() {
  const env = {
    NODE_ENV: coreEnv(),
    PORT: String(corePort()),
    HOST: coreHost(),
    IS_LOOPAR: true,
  };
  const r = redisConfig();
  if (r.host) {
    env.REDIS_HOST = r.host;
    env.REDIS_PORT = String(r.port);
    if (r.password) env.REDIS_PASSWORD = r.password;
    env.REDIS_TTL_PERMISSIONS = String(r.ttlPermissions);
  }
  const acme = caddyAcmeEmail();
  if (acme) env.CADDY_ACME_EMAIL = acme;
  const cors = socketCorsOrigin();
  if (cors) env.SOCKET_CORS_ORIGIN = cors;
  const cloud = cloudConfig();
  if (cloud.verifierUrl) env.CLOUD_VERIFIER_URL = cloud.verifierUrl;
  if (cloud.claimSecret) env.CLOUD_CLAIM_SECRET = cloud.claimSecret;
  return env;
}

/**
 * PM2 worker count, from core.json `instances` (positive int or "max",
 * default 1). Only effective in production; dev stays fork/1.
 */
export function coreInstances() {
  const v = load().instances;
  if (v === 'max' || v === -1 || v === '-1') return 'max';
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
}

/**
 * Should THIS process run singleton background jobs (email queue,
 * provisioning sweep)? Only one worker must, to avoid duplicate sends:
 * LOOPAR_ROLE=jobs → yes; =web → no; otherwise only cluster instance 0
 * (NODE_APP_INSTANCE); a single non-cluster process always runs them.
 */
export function shouldRunJobs() {
  const role = process.env.LOOPAR_ROLE;
  if (role === 'jobs') return true;
  if (role === 'web') return false;
  const inst = process.env.NODE_APP_INSTANCE;
  return inst === undefined || inst === '0';
}
