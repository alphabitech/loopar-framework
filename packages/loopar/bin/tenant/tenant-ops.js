'use strict';

/**
 * tenant-ops — the single tenant lifecycle, shared by the Tenant Manager Desk
 * entity and the TUI (they differ only in how they collect input).
 */

import fs from 'fs';
import path from 'pathe';
import { tenant, getTenantData } from './tenant-builder.js';
import CaddyManager from './caddy-manager.js';
import { corePort } from '../../core/config/core-config.js';

const SITES_DIR = path.join(process.cwd(), 'sites');

export { corePort };

/**
 * Point every tenant domain at the core through Caddy's single catch-all
 * route. Best-effort — a Caddy failure never blocks the catalog change.
 * @returns {Promise<string>} status suffix for UI messages ("" on success)
 */
export async function refreshCaddy() {
  try {
    // Primary domains plus every website domain and its local
    // <domain>.localhost alias — see tenant config `sites`.
    const domains = tenant.tenants().flatMap((t) => [
      t.domain,
      ...Object.keys(t.sites || {}).flatMap((d) => [d, `${d}.localhost`]),
    ]).filter(Boolean);
    if (!domains.length) return '';
    const caddy = new CaddyManager();
    await caddy.ensureReady();
    const ok = await caddy.registerHostCatchAll(corePort(), domains);
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

  await tenant.saveTenant({
    ...extra,
    NAME: name,
    DOMAIN: domain || undefined,
    STATUS: doActivate ? 'active' : 'suspended',
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

/** Full teardown: remove the on-disk site and drop its domain from the route. */
export async function destroyTenant(name, { removePath = true } = {}) {
  if (removePath) {
    const sitePath = path.join(SITES_DIR, name);
    if (fs.existsSync(sitePath)) {
      try { fs.rmSync(sitePath, { recursive: true, force: true }); }
      catch (err) { console.error(`[tenant-ops] rm ${sitePath}: ${err.message}`); }
    }
  }
  await refreshCaddy();
  return true;
}

/**
 * Trigger the headless installer for a freshly-provisioned tenant: POST to the
 * tenant's `/api/System/install` through the core (the portless domain resolves
 * via Caddy → the tenant's in-process instance). Used by the cloud control plane.
 *
 * @param {object} opts { domain, token?, payload? }
 */
export async function installTenant({ domain, token = null, payload = {} }) {
  if (!domain) throw new Error('installTenant: domain is required');
  const url = `http://${domain}/api/System/install?app_name=loopar`;
  const body = {
    email: '', company: '', admin_password: '', confirm_password: '',
    ...payload,
  };
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-Install-Token'] = token;

  const r = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    redirect: 'manual', // the installer ends in a redirect we don't follow
  });
  if (r.status >= 400) {
    const txt = await r.text().catch(() => '<no body>');
    throw new Error(`Install returned ${r.status}: ${txt.slice(0, 300)}`);
  }
  return { status: r.status };
}
