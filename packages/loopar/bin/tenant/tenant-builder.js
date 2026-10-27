import fs from 'fs/promises';
import { existsSync, readdirSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import path from 'pathe';
import crypto from 'node:crypto';

const SITES_DIR = path.join(process.cwd(), 'sites');

/**
 * Tenant catalog — sites/<name>/.
 *
 * A tenant's identity IS the folder name (no ID/NAME fields); tenant-specific
 * config lives in sites/<name>/config.json ({ domain, status, jwtSecret, cloud }).
 * Server-wide keys (PORT, NODE_ENV, REDIS_*, SHARED_TENANTS…) live in
 * config/core.json.
 *
 */

const TENANT_FOLDERS = [
  'sessions',
  path.join('public', 'uploads'),
  path.join('public', 'thumbnails'),
];

const tenantDir  = (name) => path.join(SITES_DIR, name);
const configPath = (name) => path.join(tenantDir(name), 'config.json');

/** Folder names under sites/ — the canonical tenant identities. */
export function tenantNames() {
  if (!existsSync(SITES_DIR)) return [];
  return readdirSync(SITES_DIR).filter((f) => {
    try { return statSync(path.join(SITES_DIR, f)).isDirectory() && !f.startsWith('.'); }
    catch { return false; }
  });
}

/** { "Alfra.dev": "alfra" } → { "alfra.dev": "alfra" }; drops empty entries. */
function normalizeSites(sites) {
  const out = {};
  for (const [domain, app] of Object.entries(sites || {})) {
    const d = String(domain || '').trim().toLowerCase();
    const a = String(app || '').trim();
    if (d && a) out[d] = a;
  }
  return out;
}

function normalize(name, c = {}) {
  const status = String(c.status || 'suspended').toLowerCase() === 'active' ? 'active' : 'suspended';
  return {
    name,
    domain: c.domain || `${name}.localhost`,
    // Extra websites served by this tenant: each domain renders its own web
    // app (the primary `domain` keeps System Settings' active web app).
    sites: normalizeSites(c.sites),
    status,
    online: status === 'active',
    jwtSecret: c.jwtSecret || null,
    // Key for reversible field secrets (password fields in `encrypt` mode).
    // Independent of jwtSecret: rotating sessions must not brick secrets.
    secretKey: c.secretKey || null,
    // Transient install gate for cloud-provisioned tenants (scrubbed after
    // install); read in-core via loopar.installToken.
    installToken: c.installToken || null,
    // Cloud control-plane secrets: { customerEmail, verifierUrl, verifierToken }.
    cloud: c.cloud || {},
  };
}

/**
 * Read a tenant's config from sites/<name>/config.json:
 * a folder without config.json is UNCONFIGURED → suspended (won't serve until a
 * `save` in the Tenant Manager writes config.json). Fails toward correct config
 * rather than limping along on old .env values.
 *
 * Returns null only when the tenant folder itself doesn't exist.
 * @returns {{name,domain,status,online,jwtSecret,cloud}|null}
 */
export function readTenant(name) {
  if (!name || !existsSync(tenantDir(name))) return null;

  const cp = configPath(name);
  if (existsSync(cp)) {
    try { return normalize(name, JSON.parse(readFileSync(cp, 'utf8')) || {}); }
    catch { /* malformed config → treat as unconfigured (bare) below */ }
  }

  // No config.json → unconfigured: listed (so you can save it) but suspended.
  return normalize(name, {});
}

/** All tenants, normalized. */
export function tenants() {
  return tenantNames().map(readTenant).filter(Boolean);
}

/** Logical status helper (kept for callers that only have a status string). */
export function tenantStatusOf(input = {}) {
  const s = typeof input === 'string' ? input : (input.status || input.STATUS);
  return String(s || 'suspended').toLowerCase() === 'active' ? 'active' : 'suspended';
}

/**
 * Single source of truth for UIs (Desk + TUI): name/domain/status from the
 * catalog, never a process state.
 * @returns {Array<{name,domain,status,online}>}
 */
export function tenantList() {
  return tenants().map((t) => ({
    name: t.name,
    domain: t.domain,
    status: t.status,
    online: t.online,
  }));
}

/** Translate an incoming patch (legacy UPPERCASE or lowercase) to config keys. */
function translatePatch(data) {
  const out = {};
  const domain = data.domain ?? data.DOMAIN;
  // Sent but empty = "remove it": the tenant falls back to <name>.localhost.
  // (Only an absent key means "unchanged".)
  if (domain !== undefined) out.domain = String(domain || '').trim().toLowerCase() || null;
  const status = data.status ?? data.STATUS;
  if (status !== undefined) out.status = String(status).toLowerCase();
  const jwt = data.jwtSecret ?? data.JWT_SECRET;
  if (jwt !== undefined) out.jwtSecret = jwt;
  if (data.sites !== undefined) out.sites = normalizeSites(data.sites);
  const sk = data.secretKey ?? data.SECRET_KEY;
  if (sk !== undefined) out.secretKey = sk;
  const it = data.installToken ?? data.INSTALL_TOKEN;
  if (it !== undefined) out.installToken = it;

  const cloud = {};
  const ce = data.customerEmail ?? data.CUSTOMER_EMAIL;
  if (ce !== undefined) cloud.customerEmail = ce;
  const vt = data.verifierToken ?? data.CLOUD_VERIFIER_TOKEN;
  if (vt !== undefined) cloud.verifierToken = vt;
  const vu = data.verifierUrl ?? data.CLOUD_VERIFIER_URL;
  if (vu !== undefined) cloud.verifierUrl = vu;
  if (Object.keys(cloud).length) out.cloud = cloud;

  return out;
}

export async function createTenantFolders(name) {
  await fs.mkdir(tenantDir(name), { recursive: true });
  for (const folder of TENANT_FOLDERS) {
    await fs.mkdir(path.join(tenantDir(name), folder), { recursive: true });
  }
  await fs.mkdir(path.join(tenantDir(name), 'config'), { recursive: true }); // db.config.json lives here
}

export async function saveTenant(data = {}) {
  const name = data.name ?? data.NAME ?? data.ID;
  if (!name) throw new Error('[tenant] name/NAME is required');

  const isNew = !existsSync(tenantDir(name));
  if (isNew) await createTenantFolders(name);

  const current = readTenant(name) || normalize(name, {});
  const patch = translatePatch(data);

  const next = {
    domain: ('domain' in patch ? patch.domain : current.domain) || `${name}.localhost`,
    status: patch.status ?? current.status ?? 'suspended',
    jwtSecret: patch.jwtSecret ?? current.jwtSecret ?? null,
    secretKey: patch.secretKey ?? current.secretKey ?? null,
    sites: patch.sites ?? current.sites ?? {},
    installToken: patch.installToken ?? current.installToken ?? null,
    cloud: { ...(current.cloud || {}), ...(patch.cloud || {}) },
  };
  if (!next.jwtSecret) delete next.jwtSecret;
  if (!next.secretKey) delete next.secretKey;
  if (!Object.keys(next.sites).length) delete next.sites;
  if (!next.installToken) delete next.installToken;   // empty → scrubbed
  // Drop empty cloud fields, then the object if nothing's left.
  if (next.cloud) {
    for (const k of Object.keys(next.cloud)) {
      if (next.cloud[k] === '' || next.cloud[k] == null) delete next.cloud[k];
    }
    if (Object.keys(next.cloud).length === 0) delete next.cloud;
  }

  writeFileSync(configPath(name), JSON.stringify(next, null, 2), 'utf8');
  return { tenantPath: tenantDir(name), isNew };
}

/** Ensure a tenant has a random JWT secret; generate + persist on first need. */
export async function ensureJwtSecret(name) {
  const t = readTenant(name);
  if (t?.jwtSecret) return t.jwtSecret;
  const secret = crypto.randomBytes(32).toString('hex');
  await saveTenant({ NAME: name, JWT_SECRET: secret });
  return secret;
}

/**
 * Ensure a tenant has a random secret-encryption key; generate + persist on
 * first need. LOSING THIS KEY MAKES THE TENANT'S ENCRYPTED SECRETS
 * UNRECOVERABLE — include sites/<tenant>/config.json in backups.
 */
export async function ensureSecretKey(name) {
  const t = readTenant(name);
  if (t?.secretKey) return t.secretKey;
  const secret = crypto.randomBytes(32).toString('hex');
  await saveTenant({ NAME: name, SECRET_KEY: secret });
  return secret;
}

export function tenantUrl(name, override = {}) {
  const domain = override.domain || readTenant(name)?.domain || `${name}.localhost`;
  // Local domains are served portless through Caddy's catch-all → the core.
  // Real domains get https. (The per-tenant port is gone.)
  const isLocal = domain === 'localhost' || domain.endsWith('.localhost');
  return isLocal ? `http://${domain}` : `https://${domain}`;
}

/** True when the domain is served locally (no public exposure). */
export function isLocalDomain(domain = '') {
  const d = String(domain || '').trim().toLowerCase();
  return d === 'localhost' || d.endsWith('.localhost');
}

/**
 * Ensure a tenant has a random install token; generate + persist on first
 * need. The token gates the pre-install setup wizard for REMOTE (public-IP)
 * clients — a fresh tenant reachable over the internet can't be seized before
 * its owner installs it. Local/LAN installs don't need it (origin is trusted).
 */
export async function ensureInstallToken(name) {
  const t = readTenant(name);
  if (t?.installToken) return t.installToken;
  const token = crypto.randomBytes(24).toString('hex');
  await saveTenant({ NAME: name, INSTALL_TOKEN: token });
  return token;
}

/**
 * The one-click install link for a remote tenant: the normal setup wizard URL
 * carrying the install token as a query param. Opening it drops a short-lived
 * setup cookie so the wizard's own POSTs are authorized — the operator never
 * pastes the token by hand.
 */
export async function installUrl(name, override = {}) {
  const token = await ensureInstallToken(name);
  return `${tenantUrl(name, override)}/loopar/system/connect?install_token=${token}`;
}

/**
 * Pre-seed `config/db.config.json` for a new tenant by copying another
 * tenant's template and picking a unique `database` name.
 */
export async function saveDbConfig({ from, to } = {}) {
  if (!from || !to) throw new Error('[tenant] saveDbConfig: { from, to } are required');
  const srcPath = path.join(SITES_DIR, from, 'config', 'db.config.json');
  if (!existsSync(srcPath)) {
    throw new Error(`[tenant] saveDbConfig: source not found at ${srcPath}`);
  }
  const tmpl = JSON.parse(readFileSync(srcPath, 'utf8'));
  tmpl.database = 'db_' + crypto.createHash('sha1').update(to + String(process.hrtime.bigint())).digest('hex').slice(0, 16);

  const dstDir = path.join(SITES_DIR, to, 'config');
  if (!existsSync(dstDir)) mkdirSync(dstDir, { recursive: true });
  writeFileSync(path.join(dstDir, 'db.config.json'), JSON.stringify(tmpl, null, 2), 'utf8');
  return tmpl.database;
}

/** Look a tenant up by name; throws (or returns the fallback) when missing. */
export function getTenantData(name, onNotFound = 'throw') {
  const t = readTenant(name);
  if (!t) {
    if (onNotFound === 'throw') throw new Error(`Tenant ${name} not found`);
    return onNotFound;
  }
  return t;
}

export const tenant = {
  tenants,
  tenantNames,
  tenantList,
  tenantStatusOf,
  readTenant,
  getTenantData,
  saveTenant,
  ensureJwtSecret,
  ensureSecretKey,
  ensureInstallToken,
  tenantUrl,
  installUrl,
  isLocalDomain,
  saveDbConfig,
};

export { tenants as tenantsList };
