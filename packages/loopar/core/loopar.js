'use strict';

import {KnexORM} from 'db-env';
import sha1 from "sha1";
import * as Helpers from "./global/helper.js";
import * as dateUtils from "./global/date-utils.js";
import { simpleGit } from 'simple-git';
import Auth from './auth/Auth.js';
import { Document } from './loopar/document.js';
import { tailwinInit } from './loopar/tailwindbase.js';
import { Server } from './server/server.js';
import { fileManage } from './file-manage.js';
import { cookieManager, sessionManager, getTenant, getRequest, requestContext } from './server/router/request-context.js';
import { markdownRenderer } from "markdown";
import {EmailService} from "./email.js"
import { cacheManager } from './cache/cache-manager.js';
import { RealtimeManager } from './realtime/RealtimeManager.js';
import { HookManager } from "./HookManager.js";
import { setupDocumentHistory } from "./document/document-history.js";
import { setupComments } from "./document/comment.js";
import { StorageManager } from "./global/storage/index.js";
import argon2 from 'argon2';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { tenant } from '../bin/tenant/tenant-builder.js';
import { deriveSecretKey, encryptSecret, decryptSecret, isEncryptedSecret } from './global/secrets.js';
import { migratePlaintextSecrets } from './global/secrets-migration.js';


export class Loopar extends Document {
  #installingApp = false;
  deskMenu = []
  pathRoot = process.cwd();
  markdownRenderer = markdownRenderer;
  renderMarkdownSSR
  utils = Helpers;
  __INSTALLED_APPS__
  hookManager = new HookManager();

  constructor() {
    super("Loopar");
    
    this.ORM = KnexORM;
    this.dateUtils = dateUtils;
    this.server = new Server();
    this.db = new this.ORM();
    this.storage = new StorageManager();

    setupDocumentHistory(this, KnexORM);
    setupComments(this);
  }

  hook(document, event, callback) {
    this.hookManager.register(document, event, callback);
  }

  emit(event, payload = null) {
    const [room, action] = event.includes(":")
      ? event.split(":")
      : ["__global__", event];
  
    const data = {
      ...(payload && typeof payload === 'object' ? payload : { data: payload }),
      user: this.auth?.user() ?? null,
    };
  
    RealtimeManager.emit(this.tenantId, room, action, data);
  }

  /**
   * Bring a tenant instance to life and plug it into the core. The tenant does
   * NOT start a server — it rides the core's (booted by startCore()). Only
   * called by getOrCreateTenantInstance when a tenant connects.
   *
   * @param {object}  opts
   * @param {string}  opts.tenantId
   * @param {string?} opts.appsBasePath
   */
  async init({
    tenantId,
    appsBasePath,
  }){
    this.hookManager.attach(this.ORM);
    this.tenantId = tenantId;
    this.tenantPath = this.makePath(this.pathRoot, "sites", tenantId);
    this.pathCore = `${process.cwd()}/packages/loopar`
    this.id = "loopar-"+sha1(tenantId);
    this.appsBasePath = appsBasePath;

    // Register this instance so the `loopar` proxy can resolve requests for
    // this tenant to it (see the registry at the bottom of the file).
    registerTenantInstance(tenantId, this);

    await this.#resolveJwtSecret();
    await this.#resolveSecretKey();

    this.auth = new Auth(
      this.authTokenName,
    );

    await this.initialize();
  }

  async initialize() {
    console.log(`......Initializing Loopar....... [${this.id}]` );
    
    await this.buildGlobalEnvironment();
    await this.loadConfig();
    await cacheManager.initialize(this);
    await this.db.initialize();
    await this.build();
    try {
      await migratePlaintextSecrets(this);
    } catch (error) {
      console.error('[secrets] plaintext migration failed:', error?.message || error);
    }
    try {
      await this.buildIcons();
    } catch (error) {
      console.log(["Err on build Icons", error])
    }
    
    this.mail = new EmailService()

    await tailwinInit(this.tenantId);

    await this.#bootstrapStorage();
  }

  async #bootstrapStorage() {
    try {
      const activeName = await this.#resolveActiveStorageName();
      if (!activeName) {
        this.storage.setActive('local');
        return;
      }

      const doc = await this.getDocument(activeName, null, null, { ifNotFound: null });
      if (!doc || typeof doc.buildDriver !== 'function') {
        console.warn(`[storage] "${activeName}" is not a valid storage provider; using local.`);
        this.storage.setActive('local');
        return;
      }

      const driver = await doc.buildDriver();
      this.storage.activateDriver(driver);
    } catch (err) {
      console.log('[storage] bootstrap skipped:', err?.message || err);
      this.storage.setActive('local');
    }
  }

  async #resolveActiveStorageName() {
    return (await this.getSettings())?.active_storage || null;
  }

  async applyStorage() {
    await this.#bootstrapStorage();
  }
  
  get authTokenName() {
    return this.id;
  }

  #jwtSecret = null;

  /**
   * Per-tenant JWT signing secret.
   *
   * SECURITY: this used to be `sha1(this.id)`, and `this.id` derives solely
   * from the tenant name — which is public (it's in the domain/URL). Anyone
   * could recompute the secret offline and forge valid tokens for any user.
   *
   * The secret is now random (256 bits), generated once per tenant and
   * persisted to `sites/<tenant>/.env` as JWT_SECRET so it survives restarts
   * (PM2 injects the tenant .env into process.env on start). Rotating or
   * first-generating it invalidates active sessions — users just log in
   * again.
   */
  get jwtSecret() {
    if (!this.#jwtSecret) {
      throw new Error('[loopar] jwtSecret requested before init() resolved it');
    }
    return this.#jwtSecret;
  }

  async #resolveJwtSecret() {
    // The per-tenant JWT secret lives in the tenant's config (config.json).
    // ensureJwtSecret reads it, or generates + persists a random one on first
    // boot. Never derived from the (public) tenant name.
    try {
      this.#jwtSecret = await tenant.ensureJwtSecret(this.tenantId);
    } catch (err) {
      // Last-resort in-process secret — still strictly better than a
      // publicly derivable one.
      console.warn('[loopar] Could not persist JWT secret for tenant:', err.message);
      this.#jwtSecret = crypto.randomBytes(32).toString('hex');
    }
  }

  #defaultWebApp = null;

  /**
   * The web app rendering the current request. A host mapped in the tenant's
   * `sites` config renders its own app (cached in `webApps` by build());
   * anything else gets System Settings' active web app. Assigned (not
   * computed) by loadConfig via Object.assign, hence the setter.
   */
  get webApp() {
    const site = getTenant()?.webApp;
    const app = site && this.webApps?.[site];
    return app?.name ? app : this.#defaultWebApp;
  }

  set webApp(value) {
    this.#defaultWebApp = value;
  }

  /** Web app of the request's website domain, or null on the main domain. */
  get requestSite() {
    return getTenant()?.webApp || null;
  }

  /**
   * Theme stylesheet for the current request: the web app's own theme
   * (sites/<tenant>/themes/<app>.css, written by App.save) when it has one,
   * else the tenant theme from System Settings.
   */
  themeCssPath() {
    const app = getTenant()?.webApp || this.#defaultWebApp?.name;
    if (app) {
      const own = this.makePath(this.tenantPath, 'themes', `${app}.css`);
      if (fs.existsSync(own)) return own;
    }
    return this.makePath(this.tenantPath, 'theme.css');
  }

  #secretKey = null;

  /**
   * Per-tenant key for reversible field secrets (see global/secrets.js).
   * LOOPAR_SECRET_KEY (process env) takes precedence, salted per tenant;
   * otherwise a random key persisted in sites/<tenant>/config.json.
   * No in-process fallback: a key that changes on restart would make every
   * stored secret unreadable, so failing loudly is the safer outcome.
   */
  async #resolveSecretKey() {
    const master = process.env.LOOPAR_SECRET_KEY;
    this.#secretKey = master
      ? deriveSecretKey(master, this.tenantId)
      : deriveSecretKey(await tenant.ensureSecretKey(this.tenantId));
  }

  #requireSecretKey() {
    if (!this.#secretKey) throw new Error('[loopar] secret key requested before init() resolved it');
    return this.#secretKey;
  }

  encryptSecret(plain) {
    return encryptSecret(plain, this.#requireSecretKey());
  }

  decryptSecret(value) {
    return decryptSecret(value, this.#requireSecretKey());
  }

  isEncryptedSecret(value) {
    return isEncryptedSecret(value);
  }

  #server = {};

  validateGitRepository(appName, repository) {
    if (!this.gitRepositoryIsValid(repository)) {
      this.throw(`The app ${appName} does not have a valid git repository`);
    }
  }

  /**
   * Tenant id for the current request (from AsyncLocalStorage). Outside a
   * request (boot, jobs) it falls back to `this.tenantId` — undefined on the
   * tenant-less core. Prefer this over `loopar.tenantId` in request paths.
   */
  get requestTenantId() {
    return getTenant()?.name ?? this.tenantId;
  }

  /**
   * Per-tenant cloud secrets, read from the ACTIVE tenant's config.json (the
   * proxy resolves `this` to the request's tenant). These used to live in the
   * tenant PROCESS env; in the core model there's one shared process, so they
   * must be read per-tenant from disk.
   */
  get installToken() {
    try { return tenant.readTenant(this.tenantId)?.installToken || null; }
    catch { return null; }
  }

  get cloudVerifier() {
    let c = {};
    try { c = tenant.readTenant(this.tenantId)?.cloud || {}; } catch { /* none */ }
    return { url: c.verifierUrl || null, token: c.verifierToken || null };
  }

  get cookie() {
    return cookieManager;
  }

  get workspace(){
    return getRequest()?.__WORKSPACE_NAME__;
  }

  getPage(document){
    return parseInt(this.session.get(`${this.workspace}${document}page`) || 1)
  }

  getQ(document){
    return this.session.get(`${this.workspace}${document}q`) || {};
  }

  setPage(document, page){
    this.session.set(`${this.workspace}${document}page`, page)
  }

  get session() {
    return sessionManager;
  }

  set server(server) {
    this.#server = server;
  }

  get server() {
    return this.#server;
  }

  set installingApp(app) { this.#installingApp = app }
  get installingApp() { return this.#installingApp }
  get installing() { return !!this.#installingApp }

  gitRepositoryIsValid(repository) {
    const regex = new RegExp(/^(((https?\:\/\/)(((([a-zA-Z0-9][a-zA-Z0-9\-\_]{1,252})\.){1,8}[a-zA-Z]{2,63})\/))|((ssh\:\/\/)?git\@)(((([a-zA-Z0-9][a-zA-Z0-9\-\_]{1,252})\.){1,8}[a-zA-Z]{2,63})(\:)))([a-zA-Z0-9][a-zA-Z0-9\_\-]{1,36})(\/)([a-zA-Z0-9][a-zA-Z0-9\_\-]{1,36})((\.git)?)$/);
    return regex.test(repository);
  }

  get installedApps(){
    this.__INSTALLED_APPS__ ??= fileManage.getConfigFile("installed-apps");
    return this.__INSTALLED_APPS__
  }

  async setApp(app) {
    await fileManage.setConfigFile('installed-apps', {...this.installedApps, ...app});
    this.__INSTALLED_APPS__ = fileManage.getConfigFile("installed-apps");
  }

  async unsetApp(app){
    const installedApps = this.installedApps;
    delete installedApps[app];
    await fileManage.setConfigFile('installed-apps', installedApps);
  }

  gitAppOptions(app) {
    return {
      baseDir: app ? this.makePath(this.pathRoot, "apps", app) : this.makePath(this.pathRoot, "apps"),
      binary: 'git',
      maxConcurrentProcesses: 6,
      trimmed: false,
    }
  }

  git(app) {
    return simpleGit(this.gitAppOptions(app));
  }

  async hash (plain){
    if (!plain) return null;
    return argon2.hash(plain, { type: argon2.argon2id });
  };

  async verifyHash(plain, stored){
    if (!plain || !stored) return false;
  
    try {
      if (stored.startsWith('$argon2')) {
        return await argon2.verify(stored, plain);
      }

      return sha1(plain) === stored;
    } catch (e) {
      console.error('[verifyHash] Error:', e.message);
      return false;
    }
  };

  #dbConfig = null;

  getDbConfig() {
    if (this.#dbConfig) return this.#dbConfig;
   
    this.#dbConfig = fileManage.getConfigFile('db.config');
    return this.#dbConfig;
  }

  async setDbConfig(config) {
    this.#dbConfig = config;
    return await fileManage.setConfigFile('db.config', config);
  }

  async systemsSettings() {
    return await this.getDocument("System Settings");
  }

  /**
   * Throw a typed error; the error middleware turns it into the wire response.
   *   status — HTTP status (number). Falls back to a numeric `code`, else 500.
   *   code   — domain identifier ('GIT_ERROR', 'DIRTY', …) or legacy numeric code.
   *   title  — short label for the UI.
   */
  throw(error, redirect = null) {
    error = typeof error === 'string' ? { code: 400, message: error } : error
    const err = new Error(error.message);
    err.status = error.status;
    err.code = error.code;
    err.title = error.title;
    err.redirect = redirect;
    // With redirects are always auth / session / csrf failures:
    // force hard reload to discard client state (csrf, user,
    // cached permissions) and do a clean bootstrap.
    err.hardRedirect = redirect ? true : false;
    // Thrown on purpose with a message meant for the user: safe to show even
    // in production (unexpected exceptions get a generic message there).
    err.expose = true;

    this.#installingApp = null;
    throw err;
  }

  get currentUser() {
    return this.auth.authUser();
  }

  async getSettings() {
    this.systemSettings ??= await this.db.getDoc("System Settings", null, ["*"], { isSingle: 1 });
    return this.systemSettings;
  }

  /**
   * Filesystem roots that back `/assets/{visibility}/` URLs.
   *
   * `Server#exposePublicDirectories` mounts `express.static` on these
   * (in this order) so the framework can serve user-uploaded files
   * regardless of which scope they belong to. The asset middleware
   * uses the same list to locate mirror `.meta.json` files for assets
   * whose binary lives in a remote driver (Cloudinary / Reference).
   *
   * Single source of truth — if you add a new scope (e.g. plugins),
   * extend this method and both the static dispatcher and the
   * middleware pick it up automatically.
   */
  getAssetRoots(visibility = 'public') {
    const uploadPath = 'uploads';
    const roots = [
      this.makePath(this.pathRoot, visibility),
      this.makePath(this.pathRoot, uploadPath, visibility),
      this.makePath(this.tenantPath, visibility),
      this.makePath(this.tenantPath, uploadPath, visibility),
    ];
    if (this.__installed__ && this.installedApps) {
      for (const app of Object.keys(this.installedApps)) {
        roots.push(this.makePath(this.pathRoot, 'apps', app, uploadPath, visibility));
      }
    }
    return roots;
  }

  /**
   * Path where an asset's binary AND its mirror live, given the
   * asset's `app` scope. Returns:
   *   apps/{app}/uploads/{visibility}/     when scoped to an app
   *   {tenant}/uploads/{visibility}/       otherwise
   *
   * Mirror files (`.meta.json`) and physical binaries (when the
   * driver is local) live side-by-side under this path so a single
   * directory tree contains everything Loopar knows about an asset.
   */
  getAssetPath({ app, visibility = 'public' } = {}) {
    const uploadPath = 'uploads';
    if (app && app.length > 0) {
      return this.makePath(this.pathRoot, 'apps', app, uploadPath, visibility);
    }
    return this.makePath(this.tenantPath, uploadPath, visibility);
  }

  /**
   * Extracts method names that start with "action" from a class,
   * walking up the prototype chain but stopping at BaseController
   * to avoid including framework-level actions.
   *
   * Returns names without the "action" prefix, lowercased first char.
   * e.g. "actionCreate" → "create"
   *
   * @param {Function} ControllerClass
   * @returns {string[]}
   */
  extractControllerMethods(ControllerClass, diff) {
    const actions = new Set();
    let proto = ControllerClass.prototype;
    let isOwner = true;
    let currentFilter = null;
  
    while (
      proto &&
      (!diff || proto.constructor?.name !== diff) &&
      proto !== Object.prototype
    ) {
      for (const key of Object.getOwnPropertyNames(proto)) {
        const descriptor = Object.getOwnPropertyDescriptor(proto, key);

        if (!descriptor || descriptor.get || descriptor.set) continue;
        if (typeof descriptor.value !== 'function') continue;
  
        if (key.startsWith('publicAction') && key.length > 12) {
          actions.add(key);
        } else if (key.startsWith('privateAction') && key.length > 13) {
          if (isOwner) actions.add(key);
        } else if (key.startsWith('action') && key.length > 6) {
          const name = key.charAt(6).toLowerCase() + key.slice(7);
          if (isOwner) {
            actions.add(key);
          } else if (currentFilter === null || currentFilter.includes(name)) {
            actions.add(key);
          }
        }
      }
  
      const thisInherited = proto.constructor?.inheritedActions ?? null;
  
      if (isOwner) {
        currentFilter = thisInherited;
      } else if (thisInherited !== null) {
        currentFilter = currentFilter === null
          ? thisInherited
          : currentFilter.filter(a => thisInherited.includes(a));
      }
  
      proto   = Object.getPrototypeOf(proto);
      isOwner = false;
    }
  
    return [...actions];
  }
}

const instances = new Map();
const initInFlight = new Map();
const coreInstance = new Loopar();

export function registerTenantInstance(tenantId, instance) {
  instances.set(tenantId, instance);
}

/** Initialized instance for a tenant, or null (does not create). */
export function getTenantInstance(tenantId) {
  // Still initializing → not usable yet (see getOrCreateTenantInstance).
  if (initInFlight.has(tenantId)) return null;
  return instances.get(tenantId) || null;
}

/**
 * Boot the CORE server — the generator. Starts HTTP + Vite + realtime + the
 * per-request tenant-resolution middleware, WITHOUT loading any tenant.
 * After this, requests are served per-tenant via the proxy; a Host with no
 * active tenant simply gets nothing (the tenant must be turned On).
 */
export async function startCore() {
  await coreInstance.server.initialize();

  // Domains-from-boot: ensure Caddy is up and routing every tenant domain to
  // this core no matter WHO booted us (PM2 resurrect after a reboot, `node
  // bin/core.js`, `yarn serve`) — not only the CLI. Fire-and-forget and
  // best-effort: a Caddy failure never blocks the core; domains just stay
  // port-only until the next refreshCaddy() (tenant On/Off, `yarn serve`).
  import("../bin/tenant/tenant-ops.js")
    .then(({ refreshCaddy }) => refreshCaddy())
    .then((suffix) => {
      if (suffix) console.warn(`⚠️  Caddy bootstrap:${suffix}`);
      else console.log("✅ Caddy bootstrap: tenant domains routed to the core");
    })
    .catch((err) => console.warn(`⚠️  Caddy bootstrap skipped: ${err.message}`));

  // Scheduled jobs of the apps (apps/<app>/jobs.js), per connected tenant.
  import("./global/scheduler.js")
    .then(({ scheduler }) => scheduler.start())
    .catch((err) => console.warn(`⚠️  Scheduler not started: ${err.message}`));

  return coreInstance;
}

/**
 * Get-or-create an initialized instance for a tenant (plug it into the core),
 * deduping concurrent callers so two simultaneous first-requests don't
 * double-init. This is how a tenant "connects" to the running core.
 */
export async function getOrCreateTenantInstance(tenantId, { appsBasePath } = {}) {
  // In-flight FIRST. `init()` registers the instance in `instances` on its
  // very first line — long before initialize() finishes — so looking at
  // `instances` first handed every concurrent request a HALF-initialized
  // tenant: DB flags still undefined → the system middleware read "needs
  // connect" → redirect to /loopar/system/connect → (by then ready, a
  // "spent" page) → /desk. That is the random "landing on Desk as if after
  // a login" seen after every core restart (nodemon) or tenant re-init.
  if (initInFlight.has(tenantId)) return initInFlight.get(tenantId);

  const existing = instances.get(tenantId);
  if (existing) return existing;

  const p = (async () => {
    const inst = new Loopar();
    inst.server = coreInstance.server;

    // Run init INSIDE an AsyncLocalStorage context for this tenant.
    // Framework internals (db-env's connector, fileManage, tailwind…) resolve
    // paths and config through the `loopar` proxy — without this context the
    // proxy would fall back to the tenant-less core and the new tenant would
    // initialize against the wrong (missing) folder.
    // (init registers the instance in `instances` on its first line, so the
    // proxy resolves to `inst` for everything after that.)
    await requestContext.run({ tenant: { name: tenantId } }, () =>
      inst.init({ tenantId, appsBasePath })
    );
    return inst;
  })();

  initInFlight.set(tenantId, p);
  try {
    return await p;
  } catch (err) {
    instances.delete(tenantId);
    throw err;
  } finally {
    initInFlight.delete(tenantId);
  }
}

/** Unplug a tenant from the core (force a fresh re-init on next request). */
export function evictTenantInstance(tenantId) {
  return instances.delete(tenantId);
}

function resolveActiveInstance() {
  const name = getTenant()?.name;
  if (name) {
    const inst = instances.get(name);
    if (inst) return inst;
  }
  return coreInstance;
}

// Per-instance cache of bound methods so `loopar.fn` keeps a stable identity
// within a tenant (and we don't rebind on every access).
const boundMethodCache = new WeakMap();

function boundMethod(inst, prop, fn) {
  let perInstance = boundMethodCache.get(inst);
  if (!perInstance) {
    perInstance = new Map();
    boundMethodCache.set(inst, perInstance);
  }
  let bound = perInstance.get(prop);
  if (!bound) {
    bound = fn.bind(inst);
    perInstance.set(prop, bound);
  }
  return bound;
}

export const loopar = new Proxy(coreInstance, {
  get(_target, prop, _receiver) {
    const inst = resolveActiveInstance();
    // Receiver is the real instance so private-field getters resolve.
    const value = Reflect.get(inst, prop, inst);
    // Bind methods to the real instance so `this.#private` works even though
    // callers hold the proxy. Non-function props (db, storage, utils…) pass
    // through untouched.
    return typeof value === 'function' ? boundMethod(inst, prop, value) : value;
  },
  set(_target, prop, value) {
    const inst = resolveActiveInstance();
    return Reflect.set(inst, prop, value, inst);
  },
  has(_target, prop) {
    return Reflect.has(resolveActiveInstance(), prop);
  },
  getPrototypeOf() {
    return Reflect.getPrototypeOf(resolveActiveInstance());
  },
  getOwnPropertyDescriptor(_target, prop) {
    const inst = resolveActiveInstance();
    const desc = Reflect.getOwnPropertyDescriptor(inst, prop);
    if (desc) desc.configurable = true; // Proxy invariant vs the fixed target
    return desc;
  },
  ownKeys() {
    return Reflect.ownKeys(resolveActiveInstance());
  },
});