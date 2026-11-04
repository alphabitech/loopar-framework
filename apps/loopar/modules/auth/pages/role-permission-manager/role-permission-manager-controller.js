'use strict';

import { PageController, loopar, BaseController, PermissionManager, ActionScanner, Op, SCOPE, normalizeScope } from 'loopar';

const SCOPE_RANK = { [SCOPE.OWN]: 1, [SCOPE.CUSTOMER]: 2, [SCOPE.ALL]: 3 };
/** Widest of two scopes, like PermissionManager ('customer' over 'own'). */
const widestScope = (a, b) => (SCOPE_RANK[a] >= SCOPE_RANK[b] ? a : b);

const getCommonActions = () => {
  return loopar.extractControllerMethods(BaseController).map(a => a.replace(/^(public)?action/i, ''))
}

// Catalog actions come Capitalized from the method names (actionList → "List")
// while grants may be stored lowercase (seeded roles, PermissionManager keys).
// Every key the client compares is `${document}:${action.toLowerCase()}`.
const permKey = (document, action) => `${document}:${String(action ?? '').toLowerCase()}`;

async function onModel(model, data, assign) {
  if (assign) {
    if (await loopar.db.count(model, data) == 0) {
      await loopar.db.insertRow(model, { name: loopar.getUniqueKey(), ...data });
    }
  } else {
    await loopar.db.deleteWhere(model, data);
  }
}

async function getActions() {
  const base = await PermissionManager.getAllActions();
  const models = await loopar.db.getAll("Module", ["name", "app_name"]);

  return [
    ...base,
    ...models.map(m => ({ document: `Module:${m.name}`, app: m.app_name, action: "view" }))
  ];
}

const lc = v => String(v ?? '').toLowerCase();
const appOf = document => ActionScanner.getApp(document);

/**
 * Every grant key that would cover (document, action), widest first:
 *   *:*  ·  *:action  ·  App:<app>:*  ·  App:<app>:action  ·  Doc:*  ·  Doc:action
 * Mirrors PermissionManager.scope().
 */
function coveringSpecs(document, action) {
  const app = appOf(document);
  const specs = [
    { document: '*', action: '*' },
    { document: '*', action },
  ];
  if (app) {
    specs.push({ document: `App:${app}`, action: '*' });
    specs.push({ document: `App:${app}`, action });
  }
  specs.push({ document, action: '*' });
  specs.push({ document, action });
  return specs;
}

/** Rows of `relation`/`names` (deny = 0) that cover the cell, any granularity. */
async function coveringRows(relation, names, document, action) {
  const nameFilter = Array.isArray(names) ? { [Op.in]: names } : names;
  const rows = await loopar.db.getAll(
    'Permission',
    ['name', 'relation_name', 'document', 'action', 'scope'],
    { relation, relation_name: nameFilter, deny: { [Op.or]: [null, 0] } }
  );
  const wanted = coveringSpecs(document, action).map(sp => `${lc(sp.document)}:${lc(sp.action)}`);
  return rows.filter(r => wanted.includes(`${lc(r.document)}:${lc(r.action)}`));
}

/**
 * Make sure (document, action) is no longer covered by any wildcard grant of
 * `entity`, WITHOUT losing what the wildcard gave to other cells: each
 * wildcard is replaced by finer grants that leave this cell out.
 *   *:action        → App:<otherApp>:action for every other app
 *                     + Doc:action for the other documents of this app
 *   App:<app>:*     → Doc:* for the other documents of the app
 *                     + Doc:<a> for this document's other actions
 *   App:<app>:action→ Doc:action for the other documents of the app
 *   Doc:*           → Doc:<a> for the other actions
 *   *:*             → refused (remove that grant explicitly)
 * Returns the rows that were replaced.
 */
async function uncoverCell(mode, entity, document, action) {
  const rows = await coveringRows(mode, entity, document, action);
  const catalog = await getActions();
  const app = appOf(document);
  const base = { relation: mode, relation_name: entity, deny: 0 };
  const replaced = [];

  const add = async (doc, act, scope) => {
    const where = { ...base, document: doc, action: act };
    if (await loopar.db.count('Permission', where)) return;
    await loopar.db.insertRow('Permission', { name: loopar.getUniqueKey(), ...where, scope: scope ?? 'all' });
  };

  for (const row of rows) {
    const d = lc(row.document), a = lc(row.action);
    const isExact = d === lc(document) && a === lc(action);
    if (isExact) continue;

    const scope = normalizeScope(row.scope);

    if (d === '*' && a === '*') {
      loopar.throw(`${entity} has the global "*:*" grant — remove it first to narrow permissions.`);
    }

    if (d === '*') {                                   // *:action
      const apps = [...new Set(catalog.map(c => c.app).filter(Boolean))];
      for (const other of apps) if (other !== app) await add(`App:${other}`, row.action, scope);
      for (const c of catalog) {
        if (c.app === app && c.document !== document && lc(c.action) === a) await add(c.document, c.action, scope);
      }
    } else if (d === lc(`App:${app}`) && a === '*') {  // App:app:*
      const docs = [...new Set(catalog.filter(c => c.app === app).map(c => c.document))];
      for (const other of docs) if (other !== document) await add(other, '*', scope);
      for (const c of catalog) {
        if (c.document === document && lc(c.action) !== lc(action)) await add(document, c.action, scope);
      }
    } else if (d === lc(`App:${app}`)) {               // App:app:action
      for (const c of catalog) {
        if (c.app === app && c.document !== document && lc(c.action) === a) await add(c.document, c.action, scope);
      }
    } else if (a === '*') {                            // Doc:*
      for (const c of catalog) {
        if (c.document === document && lc(c.action) !== lc(action)) await add(document, c.action, scope);
      }
    }

    await loopar.db.deleteRow('Permission', row.name);
    replaced.push(row);
  }

  return replaced;
}

export default class RolePermissionManagerController extends PageController {
  static freeActions=["getOwnPermissions"]
  async actionView() {
    const { role="core", user, preloaded } = this.query;

    if (!user) {
      let assigned = await loopar.db.getAll(
        'Permission',
        ['document', 'action'],
        { relation: 'Role', relation_name: role }
      );
      assigned = assigned.map(r => permKey(r.document, r.action));

      if (preloaded) return assigned;

      const roles = await loopar.db.getAll("Role", ['name'], { disabled: 0 });
      const view = await loopar.getDocument("Role Permission Manager");
      /* view.roles = roles;
      view.role = role;
      view.permissions = assigned; */
      return this.render(view, {roles, role, permissions: assigned});
    }

    const userRoles = await loopar.db.getAll('User Role', ['role'], { user });

    const rolePerms = userRoles.length > 0
      ? await loopar.db.getAll(
          'Permission',
          ['document', 'action'],
          { relation: 'Role', relation_name: { [Op.in]: userRoles.map(r => r.role) } }
        )
      : [];

    const userPerms = await loopar.db.getAll(
      'Permission',
      ['document', 'action'],
      { 
        relation: 'User', 
        relation_name: user, 
        deny: { [Op.or]: [null, 0] }
      }
    );

    const userDenies = await loopar.db.getAll(
      'Permission',
      ['document', 'action'],
      { relation: 'User', relation_name: user, deny: 1 }
    );

    const deniedSet = new Set(userDenies.map(r => permKey(r.document, r.action)));
    const deniedDocs = new Set(
      userDenies
        .filter(r => r.action === '*')
        .map(r => r.document)
    );
    const denyAll = deniedSet.has('*:*');
    const directSet = new Set(userPerms.map(r => permKey(r.document, r.action)));
    const fromRoles = rolePerms
      .map(r => permKey(r.document, r.action))
      .filter(key => {
        if (denyAll) return false;
        const [doc] = key.split(':');
        return !deniedSet.has(key) && !deniedDocs.has(doc);
      });
    const fromUser = [...directSet].filter(key => {
      if (denyAll) return false;
      const [doc] = key.split(':');
      return !deniedSet.has(key) && !deniedDocs.has(doc);
    });

    const assigned = [...new Set([...fromRoles, ...fromUser])];

    if (preloaded) return assigned;

    const roles = await loopar.db.getAll("Role", ['name'], { disabled: 0 });
    const view = await loopar.getDocument("Role Permission Manager");
    /* view.roles = roles;
    view.role = role;
    view.user = user;
    view.permissions = assigned; */
    return this.render(view, {roles, role, user, permissions: assigned});
  }

  async actionGetEntities(){
    const {mode} = this.query;
    return await loopar.db.getAll(mode, ["name"]);
  }

  async actionGetAllPerms() {
    const allPerms = await getActions();

    const grouped = {};
    for (const { document, action, app } of allPerms) {
      const appKey = app || 'Core';
      if (!grouped[appKey]) grouped[appKey] = {};
      if (!grouped[appKey][document]) grouped[appKey][document] = [];
      grouped[appKey][document].push(action);
    }

    return { grouped, commonActions: getCommonActions() };
  }

  async actionToggle() {
    const { mode = "Role", entity, document, action, assign } = this.body || {};

    if (!entity || !document || !action) {
      loopar.throw(`${mode}, document and action are required`);
    }
  
    const whereBase = {
      relation: mode,
      relation_name: entity,
      document,
      action
    };
  
    let roles = [];
    if (mode === "User") {
      roles = (await loopar.db.getAll('User Role', ['role'], { user: entity }))
        .map(r => r.role);
    }
  
    // Coverage at any granularity (exact, Doc:*, App:x:*, *:action, *:*).
    const comesFromRole = mode === "User" && roles.length
      ? (await coveringRows('Role', roles, document, action)).length > 0
      : false;

    const direct = await coveringRows(mode, entity, document, action);
    const hasDirectAllow = direct.length > 0;

    const hasDeny = await loopar.db.count('Permission', {
      ...whereBase,
      deny: 1
    });
  
    if (assign) {
      if (hasDeny) {
        await loopar.db.deleteWhere('Permission', {
          ...whereBase,
          deny: 1
        });
      }
  
      if (!comesFromRole && !hasDirectAllow) {
        await onModel("Permission", {
          ...whereBase,
          deny: 0
        }, true);
      }
    } else {
      if (hasDirectAllow) {
        // Split any wildcard so the other cells keep their grant, then drop
        // the exact one.
        await uncoverCell(mode, entity, document, action);
        await loopar.db.deleteWhere('Permission', { ...whereBase, deny: 0 });
      }

      if (mode === "User" && comesFromRole && !hasDeny) {
        await onModel("Permission", {
          ...whereBase,
          deny: 1
        }, true);
      }
    }
  
    if (mode === "Role") await this._invalidateRoleUsers(entity);
    else await PermissionManager.reload(entity);
  
    return this.success(
      `${action} was ${assign ? 'assigned' : 'removed'} to ${
        mode === 'Role' ? 'Role.' + entity : 'User.' + entity
      }`,
      { notify: { type: assign ? 'success' : 'warning' } }
    );
  }

  async actionToggleAll() {
    const { mode = "Role", entity, document, assign } = this.body || {};
    if (!entity || !document) return this.error(`${mode} and document are required`);
  
    if (mode === "Role") {
      if (!assign) {
        // Split *:action / App:x:* grants that cover this document's cells.
        const catalog = await getActions();
        for (const { action } of catalog.filter(c => c.document === document)) {
          await uncoverCell(mode, entity, document, action);
        }
      }
      await loopar.db.deleteWhere('Permission', { relation: mode, relation_name: entity, document });
      if (assign) {
        await loopar.db.insertRow('Permission', {
          name: loopar.getUniqueKey(),
          relation: mode, relation_name: entity, document, action: '*', deny: 0
        });
      }
      await this._invalidateRoleUsers(entity);
    } else {
      await loopar.db.deleteWhere('Permission', { relation: mode, relation_name: entity, document });
  
      if (assign) {
        await loopar.db.insertRow('Permission', {
          name: loopar.getUniqueKey(),
          relation: mode, relation_name: entity, document, action: '*', deny: 0
        });
      } else {
        const roles = (await loopar.db.getAll('User Role', ['role'], { user: entity })).map(r => r.role);
        const comesFromRole = roles.length
          ? await loopar.db.count('Permission', {
              relation: 'Role',
              relation_name: { [Op.in]: roles },
              document
            })
          : 0;

        if (comesFromRole) {
          await loopar.db.insertRow('Permission', {
            name: loopar.getUniqueKey(),
            relation: mode, relation_name: entity, document, action: '*', deny: 1
          });
        }
      }
    }
  
    if (mode === "User") await PermissionManager.reload(entity);
    return this.success(`All permissions ${assign ? 'assigned' : 'removed'}`, {
      notify: { type: assign ? 'success' : 'warning' }
    });
  }
  
  async actionToggleCol() {
    const { mode = "Role", entity, app, action, assign } = this.body || {};
    if (!entity || !action) loopar.throw('entity and action are required');
  
    let perms = await getActions();
    perms = app
      ? perms.filter(p => p.app === app && p.action === action)
      : perms.filter(p => p.action === action);
  
    const roles = mode === "User"
      ? (await loopar.db.getAll('User Role', ['role'], { user: entity })).map(r => r.role)
      : [];

    for (const { document } of perms) {
      if (mode === "Role") {
        if (assign) {
          const covered = (await coveringRows(mode, entity, document, action)).length > 0;
          if (!covered) {
            await onModel("Permission", { relation: mode, relation_name: entity, document, action, deny: 0 }, true);
          }
        } else {
          await uncoverCell(mode, entity, document, action);
          await loopar.db.deleteWhere('Permission', { relation: mode, relation_name: entity, document, action, deny: 0 });
        }
      } else {
        await loopar.db.deleteWhere('Permission', {
          relation: mode, relation_name: entity, document, action
        });
  
        if (assign) {
          await onModel("Permission", { relation: mode, relation_name: entity, document, action, deny: 0 }, true);
        } else {
          const comesFromRole = roles.length
            ? (await coveringRows('Role', roles, document, action)).length > 0
            : false;
  
          if (comesFromRole) {
            await onModel("Permission", { relation: mode, relation_name: entity, document, action, deny: 1 }, true);
          }
        }
      }
    }
  
    if (mode === "Role") await this._invalidateRoleUsers(entity);
    else await PermissionManager.reload(entity);
    return this.success(
      `${action} was ${assign ? 'assigned to' : 'removed from'} all Documents`,
      { notify: { type: assign ? 'success' : 'warning' } }
    );
  }

  /**
   * Set the scope ('all' | 'own' | 'customer') of one grant. Only direct grants of the
   * given relation are touched (a User can't narrow what a Role gives).
   * The cell may be covered by a wildcard grant; in that case the wildcard
   * row is the one that changes (and the response says which).
   */
  async actionSetScope() {
    const { mode = "Role", entity, document, action, scope = "all" } = this.body || {};
    if (!entity || !document || !action) loopar.throw(`${mode}, document and action are required`);
    const value = normalizeScope(scope);

    const candidates = [
      { document, action },
      { document, action: '*' },
      { document: '*', action },
      { document: '*', action: '*' },
    ];

    let target = null;
    let rows = [];
    for (const c of candidates) {
      rows = await loopar.db.getAll('Permission', ['name'], {
        relation: mode, relation_name: entity, deny: 0, ...c
      });
      if (rows.length) { target = c; break; }
    }
    if (!target) loopar.throw(`No direct grant covers ${document}:${action} for ${mode}.${entity}`);

    for (const { name } of rows) {
      await loopar.db.setValue('Permission', 'scope', value, name);
    }

    if (mode === "Role") await PermissionManager.reloadRole(entity);
    else await PermissionManager.reload(entity);

    const key = `${target.document}:${target.action}`;
    return this.success(`${key} scope set to ${value}`, { key, scope: value, notify: { type: 'success' } });
  }

  /**
   * Drop every direct row (grants AND denies) of a user, leaving only what
   * its roles provide. The fix for a user that accumulated denies while
   * experimenting in the grid.
   */
  async actionClearOverrides() {
    const { user } = this.body || {};
    if (!user) loopar.throw('user is required');
    const rows = await loopar.db.getAll('Permission', ['name'], { relation: 'User', relation_name: user });
    for (const { name } of rows) await loopar.db.deleteRow('Permission', name);
    await PermissionManager.reload(user);
    return this.success(`${rows.length} override(s) removed for ${user}`, { removed: rows.length, notify: { type: 'warning' } });
  }

  /**
   * Reset a role to what its app defines (convention defaults + `static
   * roles` of apps/<app>/installer.js). Custom roles have no definition and
   * are refused. Users assigned to the role are untouched.
   */
  async actionResetRole() {
    const { role } = this.body || {};
    if (!role) loopar.throw('role is required');

    const app = await loopar.db.getValue('Role', 'app', role, { ifNotFound: null });
    const installer = await loopar.getInstaller(app);
    if (!installer) loopar.throw(`Role "${role}" belongs to app "${app || '?'}", which has no installer to reset from.`);

    const def = await installer.resetRole(role);
    if (!def) loopar.throw(`Role "${role}" is not defined by app "${app}" — it is a custom role; edit its grants in the grid.`);

    await PermissionManager.reloadRole(role);
    return this.success(`${role} reset to its ${def.grants?.length ?? 0} default grant(s)`, { grants: def.grants?.length ?? 0, notify: { type: 'success' } });
  }

  async actionGetUserRoles() {
    const { user } = this.query;
    return await loopar.db.getAll("User Role", ["role"], { user });
  }

  async actionToggleUserRole() {
    const { user, role, assign } = this.body || {};
    if (!user || !role) loopar.throw('user and role are required');

    await onModel("User Role", { user, role }, assign);
    await PermissionManager.reload(user);

    return this.success(
      `Role ${role} ${assign ? 'assigned to' : 'removed from'} ${user}`,
      { notify: { type: assign ? 'success' : 'warning' } }
    );
  }

  /** Re-read from DB for every user of the role (db.* writes bypass ORM hooks). */
  async _invalidateRoleUsers(role) {
    await PermissionManager.reloadRole(role);
  }

  async actionGetUsers() {
    return await loopar.db.getAll("User", ["name"]);
  }

  /**
   * Subjects for the rail: roles grouped (system / per app / custom) with
   * grant + user counts, and desk users. One call, cheap enough.
   */
  async actionGetSubjects() {
    const roles = await loopar.db.getAll("Role", ["name", "app", "description", "is_system_role", "disabled"]);
    const grants = await loopar.db.getAll("Permission", ["relation_name"], { relation: "Role" });
    const userRoles = await loopar.db.getAll("User Role", ["user", "role"]);
    const users = await loopar.db.getAll("User", ["name", "email", "user_type", "disabled"], { disabled: 0 });

    const grantCount = {}, userCount = {};
    for (const g of grants) grantCount[g.relation_name] = (grantCount[g.relation_name] ?? 0) + 1;
    for (const ur of userRoles) userCount[ur.role] = (userCount[ur.role] ?? 0) + 1;

    const BASE = new Set(["System Manager", "Desk User", "Web User"]);
    const out = roles.map(r => ({
      name: r.name,
      app: r.app || null,
      description: r.description || "",
      system: Number(r.is_system_role) === 1,
      disabled: Number(r.disabled) === 1,
      group: BASE.has(r.name) || (r.app === "loopar" && Number(r.is_system_role) === 1)
        ? "system"
        : (Number(r.is_system_role) === 1 && r.app ? r.app : "custom"),
      grants: grantCount[r.name] ?? 0,
      users: userCount[r.name] ?? 0,
    }));

    return {
      roles: out,
      users: users.filter(u => u.name !== "Administrator").map(u => ({
        name: u.name, email: u.email || "", type: u.user_type || "System",
        roles: userRoles.filter(ur => ur.user === u.name).map(ur => ur.role),
      })),
    };
  }

  /**
   * App-level grant (`App:<app>` document): the "whole app" row of the grid.
   * action '*' or a single action; assign creates/removes that one row.
   */
  async actionToggleApp() {
    const { mode = "Role", entity, app, action = "*", assign, scope = "all" } = this.body || {};
    if (!entity || !app) loopar.throw("entity and app are required");
    const where = { relation: mode, relation_name: entity, document: `App:${app}`, action };

    if (assign) {
      await loopar.db.deleteWhere("Permission", { ...where, deny: 1 });
      if (!(await loopar.db.count("Permission", { ...where, deny: 0 }))) {
        await loopar.db.insertRow("Permission", {
          name: loopar.getUniqueKey(), ...where, deny: 0, app,
          scope: normalizeScope(scope),
        });
      }
    } else {
      await loopar.db.deleteWhere("Permission", { ...where, deny: 0 });
    }

    if (mode === "Role") await this._invalidateRoleUsers(entity);
    else await PermissionManager.reload(entity);

    return this.success(`App:${app}:${action} ${assign ? "granted" : "removed"}`, { notify: { type: assign ? "success" : "warning" } });
  }

  /**
   * Everything the grid needs to paint one subject, keyed by
   * `document:action(lowercase)` exactly as stored (wildcards included —
   * the client expands `*`, `App:<app>` and `Doc:*`):
   *   direct    – keys granted to the subject itself
   *   inherited – { key: [role, ...] } keys the user gets from roles (User mode only)
   *   denied    – keys the user explicitly denies (User mode only)
   *   scopes    – { key: 'own' | 'customer' } for narrowed grants
   *   assigned  – flat union (kept for existing consumers)
   */
  async actionGetResolvedPermissions() {
    const { role = "core", user } = this.query ?? {};
    const F = ['document', 'action', 'scope', 'relation_name'];
    // Widest scope per key wins (a key absent from `scopes` is 'all').
    const scopesOf = rows => {
      const out = {};
      for (const r of rows) {
        const k = permKey(r.document, r.action);
        out[k] = k in out ? widestScope(out[k], normalizeScope(r.scope)) : normalizeScope(r.scope);
      }
      return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== SCOPE.ALL));
    };

    if (!user) {
      const rows = await loopar.db.getAll('Permission', F, { relation: 'Role', relation_name: role, deny: { [Op.or]: [null, 0] } });
      const direct = [...new Set(rows.map(r => permKey(r.document, r.action)))];
      return { assigned: direct, direct, inherited: {}, denied: [], scopes: scopesOf(rows) };
    }

    const userRoles = (await loopar.db.getAll('User Role', ['role'], { user })).map(r => r.role);
    const rolePerms = userRoles.length
      ? await loopar.db.getAll('Permission', F, { relation: 'Role', relation_name: { [Op.in]: userRoles }, deny: { [Op.or]: [null, 0] } })
      : [];
    const userPerms = await loopar.db.getAll('Permission', F, { relation: 'User', relation_name: user, deny: { [Op.or]: [null, 0] } });
    const userDenies = await loopar.db.getAll('Permission', ['document', 'action'], { relation: 'User', relation_name: user, deny: 1 });

    const denied = [...new Set(userDenies.map(r => permKey(r.document, r.action)))];
    const inherited = {};
    for (const r of rolePerms) {
      const k = permKey(r.document, r.action);
      (inherited[k] ??= []).includes(r.relation_name) || inherited[k].push(r.relation_name);
    }
    const direct = [...new Set(userPerms.map(r => permKey(r.document, r.action)))];

    const scopes = scopesOf([...rolePerms, ...userPerms]);

    const assigned = [...new Set([...Object.keys(inherited), ...direct])].filter(k => !denied.includes(k));
    return { assigned, direct, inherited, denied, scopes };
  }

  async actionGetOwnPermissions(){
    return PermissionManager.getPermissions(loopar.auth.user())
  }
}