'use strict';

import { Op } from "db-env";
import { loopar } from "loopar";
import { ActionScanner } from "./ActionScanner.js";

/**
 * Process-wide singleton, but the CORE model runs one process for every tenant,
 * so all state MUST be namespaced per tenant. Previously #store/#deniedStore
 * were keyed by username alone and #publicActions was a single Set: the same
 * username in two tenants collided (last boot() won) and one tenant's public
 * actions applied to all — a cross-tenant authorization leak. Now every
 * container is nested under the request tenant (loopar.requestTenantId), the
 * same pattern cacheManager already uses for its keys.
 *
 * The ORM hooks (registered via the `loopar` proxy) resolve to the request's
 * tenant at fire time, and #reload/#emitUpdate are tenant-scoped, so wiring
 * them per boot stays correct.
 */
/**
 * Scope of a grant: how far a permitted action reaches.
 *   all → any record of the document
 *   own → only records where the user is the owner (see AuthController /
 *         BaseController.ownerField). Ownership never grants by itself: the
 *         action grant is required first, `own` only narrows it.
 * When the same key is granted twice (user + role, two roles) the widest wins.
 */
export const SCOPE = Object.freeze({ ALL: 'all', OWN: 'own' });
const SCOPE_RANK = { [SCOPE.OWN]: 1, [SCOPE.ALL]: 2 };
const normalizeScope = s => (String(s ?? '').toLowerCase() === SCOPE.OWN ? SCOPE.OWN : SCOPE.ALL);
const widest = (a, b) => (!a ? b : !b ? a : (SCOPE_RANK[a] >= SCOPE_RANK[b] ? a : b));

class PermissionManagerClass {
  // tenant -> Map(username -> Map(permKey -> scope))
  #storesByTenant = new Map();
  // tenant -> Map(username -> Set(permKey))
  #deniedByTenant = new Map();
  // tenant -> Set(permKey)
  #publicByTenant = new Map();
  // tenant -> string[]
  #allActionsByTenant = new Map();

  /** Tenant namespace for the current request (falls back to core outside one). */
  #tenant() {
    return loopar.requestTenantId ?? '__core__';
  }

  #store() {
    const t = this.#tenant();
    let m = this.#storesByTenant.get(t);
    if (!m) { m = new Map(); this.#storesByTenant.set(t, m); }
    return m;
  }

  #denied() {
    const t = this.#tenant();
    let m = this.#deniedByTenant.get(t);
    if (!m) { m = new Map(); this.#deniedByTenant.set(t, m); }
    return m;
  }

  #public() {
    const t = this.#tenant();
    let s = this.#publicByTenant.get(t);
    if (!s) { s = new Set(); this.#publicByTenant.set(t, s); }
    return s;
  }

  #buildKey(document, action) {
    return `${document.toLowerCase().replaceAll(" ", "")}:${action.toLowerCase()}`;
  }

  /**
   * App-level grants: `document = "App:<app>"` covers every document of that
   * app (same idea as the existing `Module:<name>` special case). Resolved
   * through the document's ref, so entities added to the app later are
   * covered without touching the grants.
   */
  static APP_PREFIX = 'App:';

  #appKeys(document, action) {
    const app = ActionScanner.getApp(document);
    if (!app) return [];
    const doc = `${PermissionManagerClass.APP_PREFIX}${app}`;
    return [this.#buildKey(doc, '*'), this.#buildKey(doc, action)];
  }

  #registerHooks() {
    loopar.hook("User Role", "afterSave", async ({doc}) => {
      await this.#reload(doc.user);
      this.#emitUpdate(doc.user);
    });

    loopar.hook("User Role", "afterDelete", async ({doc}) => {
      this.#store().delete(doc.user);
      this.#denied().delete(doc.user);
      this.#emitUpdate(doc.user);
    });

    loopar.hook("Permission", "afterSave", async ({doc}) => {
      if (doc.relation === 'Role') {
        await this.#reloadRole(doc.relation_name);
      } else {
        await this.#reload(doc.relation_name);
        this.#emitUpdate(doc.relation_name);
      }
    });

    loopar.hook("Permission", "afterDelete", async ({doc}) => {
      if (doc.relation === 'Role') {
        await this.#reloadRole(doc.relation_name);
      } else {
        await this.#reload(doc.relation_name);
        this.#emitUpdate(doc.relation_name);
      }
    });

    loopar.hook("Module", "afterSave", async () => { this.#allActionsByTenant.delete(this.#tenant()); });
    loopar.hook("Module", "afterDelete", async () => { this.#allActionsByTenant.delete(this.#tenant()); });
  }

  /** Boolean gate — unchanged contract: true when granted in ANY scope. */
  can(document, action, username) {
    return this.scope(document, action, username) !== null;
  }

  /**
   * Effective scope for (document, action, user): 'all' | 'own' | null.
   * null = not permitted. Administrator and public actions are always 'all'.
   */
  scope(document, action, username, { includePublic = true } = {}) {
    username = username ?? loopar.auth.user() ?? 'Guest';
    if (username === 'Administrator') return SCOPE.ALL;

    const key = this.#buildKey(document, action);

    if (includePublic && this.#public().has(key)) return SCOPE.ALL;

    const denied = this.#denied().get(username);
    if (denied?.has(key)) return null;

    const grants = this.#store().get(username);
    if (!grants) return null;

    let result = null;
    for (const k of [
      '*:*',
      this.#buildKey(document, '*'),
      this.#buildKey('*', action),
      ...this.#appKeys(document, action),
      key,
    ]) {
      const s = grants.get(k);
      if (s) result = widest(result, s);
      if (result === SCOPE.ALL) break;
    }
    return result;
  }

  /**
   * Scope the user was granted through roles, ignoring public actions: what
   * guards data a public action doesn't cover (e.g. a record's private files).
   */
  grantedScope(document, action, username) {
    return this.scope(document, action, username, { includePublic: false });
  }

  /** Public re-read from DB (for code paths that bypass the ORM hooks). */
  async reload(username) {
    await this.#reload(username);
    this.#emitUpdate(username);
  }

  async reloadRole(roleName) {
    await this.#reloadRole(roleName);
  }

  canAccessModule(moduleName, username) {
    username = username ?? loopar.auth.user() ?? 'Guest';
    if (username === 'Administrator') return true;
    if (this.can(`Module:${moduleName}`, 'view', username)) return true;

    const key = String(moduleName).toLowerCase();
    for (const ref of Object.values(loopar.getRefs() ?? {})) {
      if (String(ref.__MODULE__ ?? '').toLowerCase() !== key) continue;
      if (ref.is_child) continue;
      const doc = ref.__NAME__;
      if (this.can(doc, 'list', username) || this.can(doc, 'view', username)) return true;
    }
    return false;
  }

  invalidate(username) {
    if (username) {
      this.#store().delete(username);
      this.#denied().delete(username);
    } else {
      this.#store().clear();
      this.#denied().clear();
    }
  }

  async #reload(username) {
    if (username === 'Administrator') return;

    const userRoles = await loopar.db.getAll('User Role', ['role'], { user: username });
    const roleNames = userRoles.map(r => r.role);

    const rolePerms = roleNames.length > 0
      ? await loopar.db.getAll(
          'Permission',
          ['document', 'action', 'scope'],
          { relation: 'Role', relation_name: { [Op.in]: roleNames } }
        )
      : [];

    const userPerms = await loopar.db.getAll(
      'Permission',
      ['document', 'action', 'scope'],
      { relation: 'User', relation_name: username, deny: { [Op.ne]: 1 } }
    );

    const userDenies = await loopar.db.getAll(
      'Permission',
      ['document', 'action'],
      { relation: 'User', relation_name: username, deny: 1 }
    );

    const deniedSet = new Set(
      userDenies.map(r => this.#buildKey(r.document, r.action))
    );

    const merged = new Map();

    for (const r of [...rolePerms, ...userPerms]) {
      const key = this.#buildKey(r.document, r.action);
      if (deniedSet.has(key)) continue;
      merged.set(key, widest(merged.get(key), normalizeScope(r.scope)));
    }

    this.#store().set(username, merged);
    this.#denied().set(username, deniedSet);
  }

  async #reloadRole(roleName) {
    const users = await loopar.db.getAll('User Role', ['user'], { role: roleName });
    await Promise.all(users.map(async ({ user }) => {
      await this.#reload(user);
      this.#emitUpdate(user);
    }));
  }

  #emitUpdate(username) {
    loopar.emit(`permissionsChanged`);
  }

  async boot() {
    this.#registerHooks();
    await this.loadPublicActions();
    await this.refreshAllActions();

    const users = await loopar.db.getAll('User', ['name'], { disabled: 0 });
    await Promise.all(users.map(({ name }) => this.#reload(name)));
  }

  async loadPublicActions() {
    const raw = await ActionScanner.getPublicActions();
    this.#publicByTenant.set(this.#tenant(), new Set(
      raw.map(({ document, action }) => this.#buildKey(document, action))
    ));
  }

  async refreshAllActions() {
    this.#allActionsByTenant.set(this.#tenant(), await ActionScanner.getAllActions());
  }

  async getAllActions() {
    const t = this.#tenant();
    if (!this.#allActionsByTenant.get(t)?.length) await this.refreshAllActions();
    return [...(this.#allActionsByTenant.get(t) ?? [])];
  }

  /**
   * Snapshot for the client. `private` keeps its shape (array of permKeys)
   * so existing consumers keep working; `scopes` adds { permKey: scope } for
   * keys granted as 'own' only — a key absent from `scopes` is 'all'.
   */
  /**
   * The client only knows literal keys (it has no document → app map), so
   * app-level grants (`app:<app>:<action>`) are expanded here into one key
   * per document of that app. Widest scope wins when a document already has
   * its own key.
   */
  #expandAppGrants(grants) {
    const out = new Map(grants);
    for (const [k, s] of grants) {
      const m = /^app:([^:]+):(.+)$/.exec(k);
      if (!m) continue;
      const [, appKey, action] = m;
      for (const ref of Object.values(loopar.getRefs() ?? {})) {
        if (String(ref.__APP__ ?? '').toLowerCase().replaceAll(' ', '') !== appKey) continue;
        const key = this.#buildKey(ref.__NAME__, action);
        out.set(key, widest(out.get(key), s));
      }
    }
    return out;
  }

  getPermissions(username) {
    username = username ?? loopar.auth.user() ?? 'Guest';
    const isAdmin = username === 'Administrator';
    const grants = isAdmin ? null : this.#expandAppGrants(this.#store().get(username) ?? new Map());

    const scopes = {};
    if (grants) {
      for (const [k, s] of grants) if (s === SCOPE.OWN) scopes[k] = s;
    }

    return {
      public:  [...this.#public()],
      private: isAdmin ? null : [...grants.keys()],
      denied:  isAdmin ? [] : [...(this.#denied().get(username) ?? [])],
      scopes,
    };
  }
}

export const PermissionManager = new PermissionManagerClass();
