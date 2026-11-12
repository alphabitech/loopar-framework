import fs from 'fs/promises';
import { existsSync, readdirSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import path from 'pathe';
import crypto from 'node:crypto';

const SITES_DIR = path.join(process.cwd(), 'sites');

/**
 * Tenant catalog — sites/<name>/.
 *
 * A tenant's identity IS the folder name (no ID/NAME fields); tenant-specific
 * config lives in sites/<name>/config.json ({ domain, status, jwtSecret,
 * controlPlane, cloud }).
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

/**
 * { "/old/*": "https://new.example.com/" } → path prefix → target origin.
 * Paths must be absolute; targets must be http(s) URLs (no trailing slash,
 * the request URI is appended). Invalid entries are dropped.
 */
export function normalizeRedirects(redirects) {
  const out = {};
  for (const [from, to] of Object.entries(redirects || {})) {
    const p = String(from || '').trim();
    const t = String(to || '').trim().replace(/\/+$/, '');
    if (!p.startsWith('/') || !/^https?:\/\/[^\s/]+(\/\S*)?$/i.test(t)) continue;
    out[p] = t;
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
    // Paths of the primary domain answered with a permanent redirect at the
    // proxy (e.g. an app moved to another tenant): { "/path/*": "https://…" }.
    redirects: normalizeRedirects(c.redirects),
    status,
    online: status === 'active',
    // Control plane: this tenant may operate every other tenant (Tenant
    // Manager, provisioning) and can't be reset or destroyed. Granted from the
    // TUI/CLI or by another control-plane tenant — never by the tenant itself.
    controlPlane: c.controlPlane === true,
    // Template host: website templates install here as they are (the demos
    // tenant), so a template's demo is the template itself and updates with it.
    templateHost: c.templateHost === true,
    jwtSecret: c.jwtSecret || null,
    // Key for reversible field secrets (password fields in `encrypt` mode).
    // Independent of jwtSecret: rotating sessions must not brick secrets.
    secretKey: c.secretKey || null,
    // Transient install gate for cloud-provisioned tenants (scrubbed after
    // install); read in-core via loopar.installToken.
    installToken: c.installToken || null,
    // Cloud control-plane secrets: { customerEmail, verifierUrl, verifierToken }.
    cloud: c.cloud || {},
    // Set when a backup was restored over this tenant: a core still holding
    // the old instance re-initializes it (core/backup).
    restoredAt: c.restoredAt || null,
    // Caps of the workspace ({ users, domain_suffix }): see core/auth/tenant-limits.js.
    limits: normalizeLimits(c.limits),
  };
}

/**
 * { users: "10" } → { users: 10 }; non-positive or invalid values are dropped
 * (= no limit). `domain_suffix` is the one text limit: ".example.com" means
 * the workspace may only use domains under it (no domain of its own).
 */
export function normalizeLimits(limits) {
  const out = {};
  for (const [key, value] of Object.entries(limits || {})) {
    if (key === 'domain_suffix') {
      const suffix = String(value || '').trim().toLowerCase().replace(/^\.*/, '');
      if (/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(suffix)) out[key] = `.${suffix}`;
      continue;
    }
    const n = parseInt(value, 10);
    if (/^[a-z_]+$/.test(key) && Number.isFinite(n) && n > 0) out[key] = n;
  }
  return out;
}

/** Every domain a tenant config answers on: the primary one and its sites'. */
const domainsOf = (config) => [config?.domain, ...Object.keys(config?.sites || {})]
  .map(d => String(d || '').trim().toLowerCase()).filter(Boolean);

/**
 * Refuses a NEW domain outside the workspace's `domain_suffix` limit. Local
 * domains always pass, and domains the tenant already had are kept: a limit
 * that arrives later (a plan change) never takes a domain away.
 */
export function assertDomainLimit(current, next) {
  const suffix = next?.limits?.domain_suffix;
  if (!suffix) return;
  const had = new Set(domainsOf(current));
  const refused = domainsOf(next).filter(d => !had.has(d) && !isLocalDomain(d) && !d.endsWith(suffix));
  if (!refused.length) return;
  const error = new Error(
    `This workspace's plan doesn't include a custom domain: ${refused.join(', ')} can't be used. ` +
    `Use a domain ending in ${suffix}, or upgrade the plan.`
  );
  error.code = 403;
  error.title = 'Custom domain not included';
  throw error;
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
    controlPlane: t.controlPlane,
    templateHost: t.templateHost,
  }));
}

/**
 * What the proxy must route, from the catalog: every domain served by the core
 * (primary, websites and their local <domain>.localhost aliases) and the
 * redirects declared on primary domains.
 * @returns {{ domains: string[], redirects: Array<{host,path,to}> }}
 */
export function routingTable() {
  const all = tenants();
  const domains = [...new Set(all.flatMap((t) => [
    t.domain,
    ...Object.keys(t.sites || {}).flatMap((d) => [d, `${d}.localhost`]),
  ]).filter(Boolean))];
  const redirects = all.flatMap((t) =>
    Object.entries(t.redirects || {}).map(([p, to]) => ({ host: t.domain, path: p, to }))
  );
  return { domains, redirects };
}

/** Does `name` run the control plane? Unknown tenants never do. */
export function isControlPlane(name) {
  return readTenant(name)?.controlPlane === true;
}

/** Does `name` host website templates as they are (demos tenant)? */
export function isTemplateHost(name) {
  return readTenant(name)?.templateHost === true;
}

/** Names of every control-plane tenant. */
export function controlPlaneTenants() {
  return tenants().filter((t) => t.controlPlane).map((t) => t.name);
}

const truthy = (v) => v === true || v === 1 || v === '1' || v === 'true';

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
  if (data.redirects !== undefined) out.redirects = normalizeRedirects(data.redirects);
  if (data.limits !== undefined) out.limits = normalizeLimits(data.limits);
  const sk = data.secretKey ?? data.SECRET_KEY;
  if (sk !== undefined) out.secretKey = sk;
  const it = data.installToken ?? data.INSTALL_TOKEN;
  if (it !== undefined) out.installToken = it;
  const cp = data.controlPlane ?? data.control_plane;
  if (cp !== undefined && cp !== null && cp !== '') out.controlPlane = truthy(cp);
  const th = data.templateHost ?? data.template_host;
  if (th !== undefined && th !== null && th !== '') out.templateHost = truthy(th);
  const ra = data.restoredAt ?? data.RESTORED_AT;
  if (ra !== undefined) out.restoredAt = ra;

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
    controlPlane: patch.controlPlane ?? current.controlPlane ?? false,
    templateHost: patch.templateHost ?? current.templateHost ?? false,
    jwtSecret: patch.jwtSecret ?? current.jwtSecret ?? null,
    secretKey: patch.secretKey ?? current.secretKey ?? null,
    sites: patch.sites ?? current.sites ?? {},
    redirects: patch.redirects ?? current.redirects ?? {},
    limits: patch.limits ?? current.limits ?? {},
    installToken: patch.installToken ?? current.installToken ?? null,
    // Re-init marker: a core holding the old instance drops it when this
    // changes (backup restore, reset). Kept across saves so a plain save
    // doesn't trigger a spurious re-init.
    restoredAt: patch.restoredAt ?? current.restoredAt ?? null,
    cloud: { ...(current.cloud || {}), ...(patch.cloud || {}) },
  };
  if (!isNew) assertDomainLimit(current, next);
  if (!next.controlPlane) delete next.controlPlane;
  if (!next.templateHost) delete next.templateHost;
  if (!next.jwtSecret) delete next.jwtSecret;
  if (!next.secretKey) delete next.secretKey;
  if (!Object.keys(next.sites).length) delete next.sites;
  if (!Object.keys(next.redirects).length) delete next.redirects;
  if (!Object.keys(next.limits).length) delete next.limits;
  if (!next.installToken) delete next.installToken;   // empty → scrubbed
  if (!next.restoredAt) delete next.restoredAt;
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
  return `${tenantUrl(name, override)}/loopar/system/install?install_token=${token}`;
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
  isControlPlane,
  controlPlaneTenants,
  isTemplateHost,
  routingTable,
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
