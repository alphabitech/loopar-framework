'use strict';

import fs from 'fs';
import {
  BaseDocument,
  tenant,
  loopar,
  evictTenantInstance,
  tenantRegistry,
} from 'loopar';
import * as tenantOps from "loopar/bin/tenant/tenant-ops.js";


export default class TenantManager extends BaseDocument {
  constructor(props) {
    super(props);
  }

  async __init__(ifNotFound) {
    if (this.__DOCUMENT_NAME__) {
      const app = tenant.getTenantData(this.__DOCUMENT_NAME__, null);
      if (app || ifNotFound == "new") {
        // Stored config fills the form; values sent by the request (a save)
        // win — spreading __DATA__ last, or the save writes back the old ones.
        this.__DATA__ = {
          id: app?.name,
          domain: app?.domain,
          sites: Object.entries(app?.sites || {}).map(([d, a]) => `${d} = ${a}`).join('\n'),
          ...Object.fromEntries(Object.entries(this.__DATA__ || {}).filter(([, v]) => v != null)),
        };
        this.__IS_NEW__ = false;
      } else if (ifNotFound === 'throw') {
        loopar.throw({ code: 404, message: `Tenant ${this.__DOCUMENT_NAME__}: not found...` });
      } else if (ifNotFound === "null"){
        return null;
      }
    }

    await super.__init__();
    if (this.__DOCUMENT_NAME__) this.name = this.__DOCUMENT_NAME__;
  }

  get allApps() { return tenant.tenants(); }

  async getStatus() {
    const entry = tenantRegistry.get(this.name);
    return entry?.suspended ? "stopped" : "online";
  }

  /**
   * True when operating on the SAME tenant that serves the current request —
   * you can't suspend/evict the instance you're running inside mid-request.
   */
  #isSelf() {
    return this.name === loopar.tenantId;
  }

  /** Drop the in-process instance so it re-inits now (core-process only). */
  #evict() {
    tenantRegistry.invalidate();
    if (!this.#isSelf()) evictTenantInstance(this.name);
  }

  async __data__() {
    // Never hand tenant secrets to the form; saveTenant keeps them when absent.
    const { jwtSecret, secretKey, installToken, sites, ...data } = tenant.getTenantData(this.name);
    return { ...data, sites: Object.entries(sites || {}).map(([d, a]) => `${d} = ${a}`).join('\n') };
  }

  async save() {
    await this.validate();

    if (this.__IS_NEW__ && this.allApps.find(a => a.name === this.name)) {
      return loopar.throw({ status: 409, title: 'Conflict', message: 'Tenant already exists, try another name' });
    }

    await tenant.saveTenant({...await this.rawValues(), sites: this.#sitesMap(), ID: this.id || this.name});
    await tenantOps.refreshCaddy();
    this.#evict();
    // The running instance isn't evicted; rebuild so its website cache
    // (loopar.webApps) picks up the new sites now.
    if (this.#isSelf()) await loopar.build();

    return true;
  }

  async start() {
    await this.validate();
    await tenantOps.activate(this.name);
    this.#evict();
    return true;
  }

  async stop() {
    if (this.#isSelf()) {
      return loopar.throw("You can't suspend the workspace you're currently using.");
    }
    await tenantOps.suspend(this.name);
    evictTenantInstance(this.name);
    tenantRegistry.invalidate();
    return true;
  }

  async restart() {
    await tenantOps.reload(this.name);
    this.#evict();
    return true;
  }

  async reload() {
    return await this.restart();
  }

  validateDomain(domain) {
    if (typeof domain !== "string") return false;
    domain = domain.trim().toLowerCase();

    if (domain.endsWith('.localhost') || domain === 'localhost') {
      return /^(?!-)([a-z0-9-]{1,63}\.)*localhost$/.test(domain);
    }
    return /^(?!-)(?:[a-z0-9-]{1,63}\.)+[a-z]{2,63}$/.test(domain);
  }

  async validate() {
    if (this.domain?.trim()) {
      if (!this.validateDomain(this.domain)) {
        return loopar.throw("Invalid domain");
      }
      const conflict = this.allApps.find(
        a => a.domain === this.domain && a.name !== this.name
      );
      if (conflict) {
        return loopar.throw({ status: 409, title: 'Conflict', message: `Domain ${this.domain} is already used by tenant ${conflict.name}` });
      }
    }
    for (const [domain, app] of Object.entries(this.#sitesMap())) {
      if (!this.validateDomain(domain)) loopar.throw(`Invalid website domain "${domain}"`);
      if (!fs.existsSync(loopar.makePath(loopar.pathRoot, 'apps', app, 'installer.json'))) {
        loopar.throw(`Website ${domain}: app "${app}" doesn't exist in apps/.`);
      }
      if (domain === this.domain?.trim().toLowerCase()) {
        loopar.throw(`${domain} is already this tenant's main domain`);
      }
      const owner = this.allApps.find(a =>
        a.name !== this.name && (a.domain === domain || Object.keys(a.sites || {}).includes(domain))
      );
      if (owner) {
        loopar.throw({ status: 409, title: 'Conflict', message: `Domain ${domain} is already used by tenant ${owner.name}` });
      }
    }
    await super.validate();
  }

  #hasDomain() { return !!this.domain?.trim(); }

  /** "domain = app" lines → { domain: app }. Throws on a malformed line. */
  #sitesMap() {
    const sites = {};
    for (const raw of String(this.sites || '').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const [domain, app] = line.split('=').map(v => (v || '').trim());
      if (!domain || !app) loopar.throw(`Invalid website line "${line}". Use: domain = web app`);
      sites[domain.toLowerCase()] = app;
    }
    return sites;
  }

  /**
   * Create + turn On from the Desk. Persists the form, activates, and routes
   * the domain to the core — all via the shared ops.
   */
  async initInstance() {
    await this.validate();
    await this.save(); 
    await tenantOps.activate(this.name);
    this.#evict();

    console.log(`\n✅ ${this.name} active — served by the core`);
    console.log(`   ${this.#hasDomain() ? `http://${this.domain}` : `(no domain)`}\n`);
    return true;
  }

  async provision(opts = {}) {
    await this.validate();
    const { env = {}, dbConfigFrom = null, activate = false } = opts;

    await tenant.saveTenant({
      ...await this.rawValues(),
      sites: this.#sitesMap(),
      NAME: this.name,
      ID: this.id || this.name,
      STATUS: activate ? 'active' : 'suspended',
      ...env,
    });
    this.__IS_NEW__ = false;

    let dbName = null;
    if (dbConfigFrom) {
      dbName = await tenant.saveDbConfig({ from: dbConfigFrom, to: this.name });
    }

    await tenantOps.refreshCaddy();
    this.#evict();

    return { url: tenant.tenantUrl(this.name, { domain: this.domain, port: this.port }), dbName };
  }

  /**
   * Teardown — evict the in-process instance, then delegate the on-disk
   * removal + Caddy refresh to the shared ops. Idempotent.
   */
  async destroy({ removePath = true } = {}) {
    if (this.#isSelf()) {
      return loopar.throw("You can't destroy the workspace you're currently using.");
    }
    evictTenantInstance(this.name);
    await tenantOps.destroyTenant(this.name, { removePath });
    tenantRegistry.invalidate();
    return true;
  }

  async #getTenantList(){
    return tenant.tenantList().map(t => ({
      name: t.name,
      domain: t.domain,
      status: t.online ? "online" : "stopped",
    }));
  }

  async getList({ fields = null, filters = {}, q = null, rowsOnly = false } = {}) {
    q ??= {};

    const pagination = {
      page: loopar.getPage(this.__ENTITY__.name),
      pageSize: 10,
      totalPages: 1,
      totalRecords: 0,
      sortBy: "id",
      sortOrder: "asc",
      __ENTITY__: this.__ENTITY__.name
    };

    const listFields = this.getFieldListNames();
    const allRows = await this.#getTenantList([]);

    const nameFilter = (this.name || "").toLowerCase();
    const filtered = allRows.filter(row =>
      (row.name || "").toLowerCase().includes(nameFilter)
    );

    pagination.totalRecords = filtered.length;
    pagination.totalPages = Math.max(1, Math.ceil(filtered.length / pagination.pageSize));

    if (pagination.page > pagination.totalPages) pagination.page = pagination.totalPages;

    const startIndex = (pagination.page - 1) * pagination.pageSize;
    const rows = filtered.slice(startIndex, startIndex + pagination.pageSize);

    const selfPagination = JSON.parse(JSON.stringify(pagination));

    return Object.assign((rowsOnly ? {} : await this.__meta__()), {
      labels: this.getFieldListLabels(),
      fields: listFields,
      rows: rows.sort((a, b) => (b.name === "dev") - (a.name === "dev")),
      pagination: selfPagination,
      q
    });
  }
}
