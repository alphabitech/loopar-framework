'use strict';

/**
 * tenant-ops — the single tenant lifecycle, shared by the Tenant Manager Desk
 * entity and the TUI (they differ only in how they collect input).
 */

import fs from 'fs';
import path from 'pathe';
import { tenant, getTenantData, RESERVED_TENANT_NAMES } from './tenant-builder.js';
import CaddyManager from './caddy-manager.js';
import http from 'node:http';
import { corePort, coreHost } from '../../core/config/core-config.js';
import knexFactory from 'knex';
import { readDbConfig, dialectOf } from '../../core/backup/database.js';

const SITES_DIR = path.join(process.cwd(), 'sites');

export { corePort };

/**
 * Point every tenant domain at the core through Caddy's single catch-all
 * route. Best-effort — a Caddy failure never blocks the catalog change.
 * @returns {Promise<string>} status suffix for UI messages ("" on success)
 */
export async function refreshCaddy() {
  try {
    // Even with no domains left the route is rewritten: the last deleted
    // tenant must stop being proxied.
    const { domains, redirects } = tenant.routingTable();
    const caddy = new CaddyManager();
    await caddy.ensureReady();
    const ok = await caddy.registerHostCatchAll(corePort(), domains, redirects);
    return ok ? '' : ' · caddy route not updated';
  } catch (err) {
    return ` · caddy: ${err.message}`;
  }
}

/** Turn a tenant On (served on next request; the core picks it up). */
export async function activate(name) {
  await tenant.saveTenant({ NAME: name, STATUS: 'active' });
  return refreshCaddy();
}

/** Turn a tenant Off (its domain shows the suspended page). */
export async function suspend(name) {
  await tenant.saveTenant({ NAME: name, STATUS: 'suspended' });
  return '';
}

/** Reload: re-assert active; config/.env changes apply on the next request. */
export async function reload(name) {
  await tenant.saveTenant({ NAME: name, STATUS: 'active' });
  return '';
}

/**
 * Create a tenant, suspended by default (cloud-coherent) unless `activate:true`.
 * Writes config.json and routes its domain to the core.
 *
 * @param {object} data  { name, domain?, ...cloud }
 * @param {object} opts  { activate?: boolean }
 */
export async function createTenant(data, { activate: doActivate = false } = {}) {
  const { name, domain, ...extra } = data;
  if (!name) throw new Error('name is required');
  if (getTenantData(name, null)) throw new Error(`Tenant "${name}" already exists`);

  // The first tenant of a server runs its control plane (code work: git,
  // versions, builds), as `dev` does on a fresh development install.
  const firstOperator = tenant.controlPlaneTenants().length === 0;
  await tenant.saveTenant({
    ...extra,
    NAME: name,
    DOMAIN: domain || undefined,
    STATUS: doActivate ? 'active' : 'suspended',
    ...(firstOperator ? { controlPlane: true } : {}),
  });

  await refreshCaddy();

  // Remote tenants (public domain) get a tokened install link so the setup
  // wizard can be opened safely over the internet; local tenants don't need
  // one (the wizard is unrestricted from loopback/LAN).
  let installUrl = null;
  const effectiveDomain = domain || `${name}.localhost`;
  if (!tenant.isLocalDomain(effectiveDomain)) {
    installUrl = await tenant.installUrl(name, { domain: effectiveDomain });
  }

  return { name, activated: doActivate, installUrl };
}

/** Server databases that must never be dropped, whatever a config says. */
const PROTECTED_DATABASES = new Set([
  'information_schema', 'mysql', 'performance_schema', 'sys',
  'postgres', 'template0', 'template1',
]);

/**
 * A tenant name is its folder under sites/: one plain path segment (letters,
 * numbers, "-" and "_"; no dots or separators). A leading "_" is allowed —
 * throwaway tenants (__loopar_test_<pid>__) must stay removable.
 */
export function isTenantName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(name)
    && !RESERVED_TENANT_NAMES.has(name.toLowerCase());
}

/** Throws unless `name` is a tenant that may be reset or destroyed. */
export function assertDisposable(name) {
  if (!isTenantName(name)) {
    throw new Error(`Invalid tenant name "${name}"`);
  }
  if (tenant.isControlPlane(name)) {
    throw new Error(`"${name}" runs the control plane; it can't be reset or destroyed. Revoke its control plane first.`);
  }
}

/**
 * Throws while `name` is turned on: a running tenant is suspended first and
 * reset or destroyed after, so nobody wipes by accident the one that is serving.
 */
export function assertStopped(name, verb = 'destroy') {
  if (tenant.readTenant(name)?.status === 'active') {
    throw new Error(`"${name}" is running. Turn it off first, then ${verb} it.`);
  }
}

/**
 * Throws unless the control-plane flag of `name` may change to `on`.
 * `actor` is the tenant asking (the Desk); null for the TUI/CLI, which run
 * on the server itself.
 */
export function assertControlPlaneChange(name, on, { actor = null } = {}) {
  const current = tenant.readTenant(name);
  if (!current) throw new Error(`Tenant "${name}" not found`);
  if (current.controlPlane === on) return;
  if (on) return;
  if (actor && actor === name) {
    throw new Error(`You can't revoke the control plane of the workspace you're using.`);
  }
  if (tenant.controlPlaneTenants().length <= 1) {
    throw new Error(`"${name}" is the last control-plane tenant; grant another one first.`);
  }
}

/** Grant or revoke the control plane of a tenant (TUI/CLI). */
export async function setControlPlane(name, on) {
  assertControlPlaneChange(name, on);
  await tenant.saveTenant({ name, controlPlane: on });
  return on;
}

const dbConfigPath = (name) => path.join(SITES_DIR, name, 'config', 'db.config.json');

/** Identity of a tenant's server database, to detect two tenants sharing one. */
function serverDbKey(cfg) {
  const c = cfg.connection || {};
  return [dialectOf(cfg), c.host || cfg.host || 'localhost', c.port || cfg.port || '', cfg.database].join('|');
}

/**
 * Drop a tenant's database. SQLite lives in sites/<name>/database (removed
 * here); MySQL/MariaDB and PostgreSQL get a DROP DATABASE on their server,
 * using the tenant's own db.config.json. Refuses when another tenant points
 * at the same server database. Works without the framework (CLI/TUI too);
 * in the core, unplug the tenant first so its pool is closed.
 *
 * @returns {Promise<string>} the dialect dropped ('none' when unconfigured)
 */
export async function dropTenantDatabase(name) {
  const dbDir = path.join(SITES_DIR, name, 'database');
  const removeLocal = () => fs.rmSync(dbDir, { recursive: true, force: true });

  if (!fs.existsSync(dbConfigPath(name))) { removeLocal(); return 'none'; }

  const root = path.dirname(SITES_DIR);
  const cfg = readDbConfig(root, name);
  const dialect = dialectOf(cfg);
  if (dialect === 'sqlite') { removeLocal(); return 'sqlite'; }

  const database = String(cfg.database || '');
  // Connected but never installed (the setup wizard stopped after "connect"):
  // the config names a server and no database, so there is nothing to drop.
  if (!database) { removeLocal(); return 'none'; }
  if (!/^[A-Za-z0-9_$-]+$/.test(database) || PROTECTED_DATABASES.has(database.toLowerCase())) {
    throw new Error(`Refusing to drop database "${database}".`);
  }

  const key = serverDbKey(cfg);
  for (const other of fs.readdirSync(SITES_DIR)) {
    if (other === name || !fs.existsSync(dbConfigPath(other))) continue;
    if (serverDbKey(readDbConfig(root, other)) === key) {
      throw new Error(`Database "${database}" is also used by tenant "${other}"; not dropped.`);
    }
  }

  const c = { ...(cfg.connection || {}) };
  const host = c.host || cfg.host || 'localhost';
  const user = c.user || cfg.user;
  const password = c.password ?? cfg.password;

  let knex;
  try {
    if (dialect === 'mysql') {
      knex = knexFactory({ client: 'mysql2', connection: { host, port: c.port || 3306, user, password }, pool: { min: 0, max: 1 } });
      await knex.raw(`DROP DATABASE IF EXISTS \`${database}\``);
    } else if (dialect === 'postgres') {
      knex = knexFactory({ client: 'pg', connection: { host, port: c.port || 5432, user, password, database: 'postgres' }, pool: { min: 0, max: 1 } });
      // Postgres refuses to drop a database with open sessions.
      await knex.raw('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ? AND pid <> pg_backend_pid()', [database]);
      await knex.raw(`DROP DATABASE IF EXISTS "${database}"`);
    } else {
      throw new Error(`Dropping a "${cfg.dialect}" database isn't supported; drop "${database}" by hand.`);
    }
  } finally {
    await knex?.destroy().catch(() => {});
  }

  removeLocal();
  return dialect;
}

/**
 * Disconnect a tenant from its data so it can be set up from scratch: drop
 * its database, forget the connection and install state, clear sessions.
 * The tenant itself stays (domain, websites, secrets, status, uploaded files)
 * and lands on the setup wizard on its next request.
 */
export async function resetTenant(name) {
  assertDisposable(name);
  assertStopped(name, 'reset');
  const site = path.join(SITES_DIR, name);
  if (!fs.existsSync(site)) throw new Error(`Tenant "${name}" not found`);

  const dialect = await dropTenantDatabase(name);

  for (const file of ['db.config.json', 'installed-apps.json', 'loopar.config.json']) {
    fs.rmSync(path.join(site, 'config', file), { force: true });
  }
  for (const dir of ['database', 'sessions']) {
    fs.rmSync(path.join(site, dir), { recursive: true, force: true });
    fs.mkdirSync(path.join(site, dir), { recursive: true });
  }

  // Tell a core still holding the old instance to drop it (it compares this
  // marker on the next request — same path a terminal restore uses).
  await tenant.saveTenant({ NAME: name, RESTORED_AT: new Date().toISOString() });
  return dialect;
}

/**
 * Full teardown: drop the tenant's database, remove the on-disk site and
 * drop its domain from the route.
 */
export async function destroyTenant(name, { removePath = true, dropDatabase = true } = {}) {
  assertDisposable(name);
  assertStopped(name);
  if (removePath) {
    const sitePath = path.join(SITES_DIR, name);
    if (fs.existsSync(sitePath)) {
      if (dropDatabase) await dropTenantDatabase(name);
      try { fs.rmSync(sitePath, { recursive: true, force: true }); }
      catch (err) { console.error(`[tenant-ops] rm ${sitePath}: ${err.message}`); }
    }
  }
  await refreshCaddy();
  return true;
}

/**
 * Trigger the headless installer for a freshly-provisioned tenant: POST to the
 * tenant's `/api/System/install` on the core itself, with the tenant's domain
 * as Host (the core resolves the tenant from it). It doesn't go through the
 * proxy: no DNS, certificate or redirect of the new domain is in the way, and
 * a proxy answer can't be mistaken for a finished install. Used by the cloud
 * control plane.
 *
 * The install answers at once with a background job; this follows it through
 * `/api/System/job` until it ends, so no request is held open for minutes (Node
 * cuts them at 5) and a long install can't read as a failed one.
 * `onProgress(job)` gets each new state ({ state, step, percent, ... }).
 *
 * @param {object} opts { domain, token?, payload?, onProgress?, timeoutMs? }
 */
export async function installTenant({ domain, token = null, payload = {}, onProgress = null, timeoutMs = 30 * 60 * 1000 }) {
  if (!domain) throw new Error('installTenant: domain is required');
  const body = JSON.stringify({
    email: '', company: '', admin_password: '', confirm_password: '',
    ...payload,
  });

  const r = await coreRequest({ domain, path: '/api/System/install?app_name=loopar', body, token });
  if (r.status >= 400) {
    throw new Error(`Install returned ${r.status}: ${(r.text || '<no body>').slice(0, 300)}`);
  }

  const job = jobOf(r.text);
  if (!job?.id) return { status: r.status };

  // Follow the job until it ends.
  const started = Date.now();
  let last = '';
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const poll = await coreRequest({ domain, path: `/api/System/job?id=${encodeURIComponent(job.id)}&log=0`, body: '{}' })
      .catch((e) => ({ status: 0, text: e.message }));
    const state = poll.status < 400 ? jobOf(poll.text) : null;

    if (state) {
      const key = `${state.state}|${state.step}|${state.percent}`;
      if (key !== last) {
        last = key;
        try { onProgress?.(state); } catch { /* best effort */ }
      }
      if (state.state === 'completed') return { status: 200, job: state };
      if (state.state === 'failed') throw new Error(`Install failed: ${state.error || 'unknown error'}`);
    } else if (poll.status === 404) {
      throw new Error('Install job lost (the core restarted during the install?)');
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Install still running after ${Math.round(timeoutMs / 60000)} min: giving up waiting (it may still finish).`);
    }
  }
}

/** The `job` in a JSON answer (`{ job }` or wrapped in `data`), or null. */
function jobOf(text) {
  try {
    const parsed = JSON.parse(text || '{}');
    return parsed?.job || parsed?.data?.job || null;
  } catch {
    return null;
  }
}

/** POST to a tenant on the core itself (Host = its domain), body read whole. */
function coreRequest({ domain, path, body, token = null }) {
  const headers = {
    Host: domain,
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  };
  if (token) headers['X-Install-Token'] = token;

  const bind = coreHost();
  const host = !bind || bind === '0.0.0.0' || bind === '::' ? '127.0.0.1' : bind;

  return new Promise((resolve, reject) => {
    const req = http.request(
      { host, port: corePort(), method: 'POST', path, headers },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { if (text.length < 1_000_000) text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, text }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}
