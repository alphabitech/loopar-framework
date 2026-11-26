import path from "pathe";
import fs from "fs";
import { loopar, fileManage, Op } from "loopar";
import BaseDocument from "../../../../../../core/document/base-document.js";
import { readRenameRecords, applyRenameToDatabase } from "../../../../../../core/document/entity-rename.js";
import { dropForeignKeys, syncForeignKeys } from "../../../../../../core/document/foreign-keys.js";
// Progress for a background job (App Manager); no-ops outside one.
import { jobStep, jobProgress, jobRange, jobLog, jobOnce } from "../../../../../../core/jobs/jobs.js";
import { pendingMigrations, runMigrations, baselineMigrations } from "../../../../../../core/document/app-migrations.js";
import { normalizeScope } from "../../../../../../core/auth/PermissionManager.js";
import { readAppHeader, isTemplateHeader, isTemplateHostTenant, belongsToOtherTenant, parseRequires, loadInstaller, installedDependents } from "./template.js";

/**
 * Requirement chain being installed (guards against cycles), one per tenant:
 * the core serves every tenant, and two of them installing apps with the same
 * requirement at once are not a cycle.
 */
const requirementChains = new Map();
function requirementChain() {
  const key = loopar.tenantId || '';
  if (!requirementChains.has(key)) requirementChains.set(key, new Set());
  return requirementChains.get(key);
}

/** The framework app: its document names are reserved for every tenant. */
const FRAMEWORK_APP = "loopar";

/**
 * Development only: makes an install or update fail on purpose, to try the
 * way back (undo / snapshot). The file sites/<tenant>/.fail-install holds
 * "<app> [n]": that app's install fails after writing n documents (half of
 * them when n is left out). Read on every install: no restart needed.
 */
function injectedFailureAfter(appName, total) {
  if (process.env.NODE_ENV === "production" || !loopar.tenantPath) return null;
  const file = path.join(loopar.tenantPath, ".fail-install");
  if (!fs.existsSync(file)) return null;
  const [app, n] = fs.readFileSync(file, "utf8").trim().split(/\s+/);
  if (!app || app !== appName) return null;
  const after = Number.parseInt(n, 10);
  return Number.isFinite(after) && after >= 0 ? after : Math.floor(total / 2);
}

function entryAppOwner(ent, entryKey) {
  if (ent.__app__ != null) return ent.__app__;
  if (ent.app != null) return ent.app;

  return null;
}

function entryRoot(ent, entryKey) {
  if (ent.__root__ != null) return ent.__root__;
  if (ent.root != null) return ent.root;
  
  return null;
}

export default class Installer extends BaseDocument {
  /**
   * Roles an app declares, seeded (idempotently: only missing rows are
   * inserted, an admin's later edits are kept) after every install/update.
   *
   *   static roles = [
   *     { name: '<AppName> Manager', description: '…', is_system_role: 1,
   *       grants: [{ document: 'App:<AppName>', action: '*' }] },
   *     // extend a role owned by another app (e.g. the base "Web User"):
   *     { name: 'Web User', grants: [{ document: '<Page Name>, action: 'view', scope: 'own' }] },
   *   ];
   *
   * Grant: { document, action, scope = 'all' | 'own' | 'portal', deny = 0 }.
   * `document` may be an entity, '*', 'App:<app>' (every document of the
   * app, including ones added later) or 'Module:<module>' (sidebar).
   */
  static roles = [];

  /**
   * Convention — every app gets two roles without declaring anything:
   *   "<App> Manager": everything in the app, nothing else of the system.
   *   "<App> User":    reads everything in the app (view/list/search — so
   *                    selects and catalogs work), writes only its own
   *                    records (create/update/delete… with scope 'own').
   * The admin then widens or narrows per document in the permission manager.
   * Declared `static roles` are added on top; one with the same name replaces
   * the default. `static defaultRoles = false` opts out (loopar does).
   */
  static defaultRoles = true;

  /**
   * Documents the app shows to portal users. When declared, the convention
   * adds "<App> Portal": view/list/search on each of them with scope 'portal',
   * so a portal user only ever reaches the records of the subjects it belongs
   * to (auth/portal-scope.js). Each document must carry the portal provider's
   * link column (or override `portalField`/`portalCondition` in its
   * controller). Writes are granted explicitly in `static roles`.
   */
  static portalDocuments = [];

  async defaultRoles() {
    if (this.constructor.defaultRoles === false) return [];
    const label = loopar.utils.Capitalize(String(this.app_name).replace(/[-_]+/g, ' '));
    const app = `App:${this.app_name}`;
    const portalDocuments = this.constructor.portalDocuments || [];
    const portal = portalDocuments.length ? [{
      name: `${label} Portal`,
      description: `Portal users of the ${label} app: see only their own records.`,
      is_system_role: 1,
      grants: portalDocuments.flatMap(document => ["view", "list", "search"].map(action => ({ document, action, scope: "portal" }))),
    }] : [];
    return [
      ...portal,
      {
        name: `${label} Manager`,
        description: `Full access to every document of the ${label} app, nothing else of the system.`,
        is_system_role: 1,
        grants: [{ document: app, action: "*" }],
      },
      {
        name: `${label} User`,
        description: `Reads everything in the ${label} app; creates and edits only its own records.`,
        is_system_role: 1,
        grants: [
          { document: app, action: "view",   scope: "all" },
          { document: app, action: "list",   scope: "all" },
          { document: app, action: "search", scope: "all" },
          { document: app, action: "*",      scope: "own" },
        ],
      },
    ];
  }

  /**
   * Roles this app defines: convention defaults + `static roles`. A declared
   * role replaces the default with the same name, whatever its case ("ERP
   * Manager" replaces the convention's "Erp Manager"): role names that differ
   * only in case are one role.
   */
  async appRoles(declared = this.constructor.roles) {
    const byName = new Map();
    const key = (name) => String(name).trim().toLowerCase();
    for (const r of await this.defaultRoles()) byName.set(key(r.name), r);
    for (const r of (Array.isArray(declared) ? declared : [])) if (r?.name) byName.set(key(r.name), r);
    return [...byName.values()];
  }

  /**
   * Roles of this app that differ only in case from one it defines (left by
   * an earlier install, before declared roles replaced defaults by any case)
   * are retired: their users move to the defined role and their grants go,
   * so no unseen role keeps permissions.
   */
  async #retireCaseDuplicates(roles) {
    const defined = new Map(roles.filter((r) => r?.name).map((r) => [r.name.trim().toLowerCase(), r.name]));
    const stored = await loopar.db.getList("Role", ["name"], { app: this.app_name }, { all: true, includeDeleted: true });
    const names = new Set(stored.map((r) => r.name));
    for (const { name } of stored) {
      const keep = defined.get(String(name).trim().toLowerCase());
      // Both spellings stored apart (a case-blind database never holds two).
      if (!keep || keep === name || !names.has(keep)) continue;
      console.log([`[installer] retiring role`, name, `→ ${keep} (${this.app_name})`]);
      const holders = await loopar.db.getList("User Role", ["name", "user"], { role: name }, { all: true, includeDeleted: true });
      for (const h of holders) {
        const has = await loopar.db.getAll("User Role", ["name"], { user: h.user, role: keep });
        if (has.length) await loopar.db.deleteRow("User Role", h.name, { force: true });
        else await loopar.db.qx()("User Role").where({ name: h.name }).update({ role: keep });
      }
      for (const { name: grant } of await loopar.db.getList("Permission", ["name"], { relation: "Role", relation_name: name }, { all: true, includeDeleted: true })) {
        await loopar.db.deleteRow("Permission", grant, { force: true });
      }
      await loopar.db.deleteRow("Role", name, { force: true });
    }
  }

  /**
   * Put one role back to what this app defines: drop EVERY grant of the role
   * (direct edits, denies, split wildcards — tombstones included) and seed
   * the declared grants again. Users keep the role. Returns the definition
   * used, or null when this app doesn't define that role.
   */
  async resetRole(roleName) {
    const def = (await this.appRoles()).find(r => r.name === roleName);
    if (!def) return null;
    const rows = await loopar.db.getList("Permission", ["name"], { relation: "Role", relation_name: roleName }, { all: true, includeDeleted: true });
    for (const { name } of rows) await loopar.db.deleteRow("Permission", name, { force: true });
    await this.seedRoles([def]);
    return def;
  }

  async seedRoles(declared = this.constructor.roles) {
    const roles = await this.appRoles(declared);
    if (roles.length === 0) return;
    await this.#retireCaseDuplicates(roles);

    // `db.count` also counts soft-deleted rows, so a role/grant the admin
    // deleted would look "present" and never come back — and its tombstone
    // would collide with the unique name on re-insert. Seeding means: if it
    // is not ALIVE, purge any tombstone and create it fresh.
    const alive = async (document, where) =>
      (await loopar.db.getAll(document, ["name"], where)).length > 0;
    const purgeTombstones = async (document, where) => {
      const rows = await loopar.db.getList(document, ["name"], where, { all: true, includeDeleted: true });
      for (const { name } of rows) await loopar.db.deleteRow(document, name, { force: true });
    };

    for (const role of roles) {
      if (!role?.name) continue;

      if (!(await alive("Role", { name: role.name }))) {
        await purgeTombstones("Role", { name: role.name });
        console.log([`[installer] seeding role`, role.name, `(${this.app_name})`]);
        const doc = await loopar.newDocument("Role", {
          name: role.name,
          app: this.app_name,
          description: role.description ?? "",
          is_system_role: role.is_system_role ?? 1,
          disabled: 0,
        });
        await doc.save({ validate: false });
      }

      for (const g of role.grants ?? []) {
        if (!g?.document || !g?.action) continue;
        const where = { relation: "Role", relation_name: role.name, document: g.document, action: g.action };
        if (await alive("Permission", where)) continue;
        await purgeTombstones("Permission", where);
        await loopar.db.insertRow("Permission", {
          name: `Role-${role.name}-${g.document}-${g.action}`,
          ...where,
          app: this.app_name,
          deny: g.deny ? 1 : 0,
          scope: normalizeScope(g.scope),
        });
      }
    }
  }

  async getDocumentData(document, root) {
    return await fileManage.getConfigFile(document, root);
  }

  getNameToFileName(name) {
    return loopar.utils.decamelize(name, { separator: '-' });
  }

  checkIfAppExists() {
    return fileManage.existFileSync(loopar.makePath('apps', this.app_name, 'installer.js'));
  }

  async restartInstaller() {
    const installerRoute = loopar.makePath('apps', this.app_name, 'installer.js');

    if (fileManage.existFileSync(installerRoute)) {
      const InstallerModel = await fileManage.importClass(installerRoute);
      new InstallerModel(await this.values(true)).install();
    } else {
      loopar.throw(`App ${this.app_name} not provide a installer model`);
    }
  }

  async unInstall() {
    if (this.app_name === 'loopar') {
      loopar.throw("You can't uninstall app Loopar");
    }
    await this.#assertNoDependents();

    // installingApp short-circuits loopar.build(); a failure that doesn't go
    // through loopar.throw (e.g. a SqliteError) must not leave it stuck.
    try {
      return await this.#unInstall();
    } finally {
      loopar.installingApp = null;
    }
  }

  async #unInstall() {
    // Uninstalling deletes the app's records: a snapshot first, as before an
    // install. Once per job (a cascade uninstalls several apps).
    if (loopar.tenantId) await this.#safetySnapshot("uninstalling");

    console.log("Uninstalling App", this.app_name);
    loopar.installingApp = this.app_name;
    // Records go in the installer's order, not the links': the database keys
    // come back from the refs once the app is gone.
    await dropForeignKeys(loopar.db);

    const moduleRoute = loopar.makePath('apps', this.app_name);
    const appData = await fileManage.getConfigFile('installer', moduleRoute);

    const unInstallEntity = async (e, ent) => {
      const [constructor, name] = e.split(':');

      if(await loopar.db.hasEntity(constructor, name)){
        const entityData = await this.getDocumentData(name, entryRoot(ent, e));
        if(entityData){
          const doc = await loopar.getDocument(constructor, name);
          console.warn([`Uninstalling ${constructor}:${name}`]);
          jobLog(`Removed ${constructor}:${name}`);
          await doc.delete({ sofDelete: false, force: true });
        }else{
          console.log([`No data found for ${constructor}:${name}, skipping...`]);
        }
      }
    }

    const unInstallDocument = async (e, ent) => {
      const [constructor, name] = e.split(':');
      // A partial install can leave docs whose entity (table) was never created.
      if (!await loopar.db.hasEntity("Entity", constructor) && !await loopar.db.hasEntity("Builder", constructor)) {
        console.log([`[installer] ${constructor} not installed in this tenant, skipping ${e}`]);
        return;
      }
      if (await loopar.db.count(constructor, name)) {
        console.warn([`Deleting ${constructor}:${name}`]);
        jobLog(`Deleted ${constructor}:${name}`);
        const doc = await loopar.getDocument(constructor, name);
        await doc.delete({ sofDelete: false, force: true, build: false });
      }
    }

    const removalKeys = Object.keys(appData.documents).reverse();
    let removedCount = 0;
    jobStep(`Uninstalling ${this.app_name}: removing ${removalKeys.length} documents`, 5);
    jobRange(5, 85);
    for (const e of removalKeys) {
      const ent = appData.documents[e];
      jobProgress(++removedCount, removalKeys.length, e);
      const owner = entryAppOwner(ent, e);
      if (owner && owner !== this.app_name) continue;

      if(entryRoot(ent, e)){
        await unInstallEntity(e, ent);
      }else{
        await unInstallDocument(e, ent);
      }
    }

    loopar.installingApp = null;

    if(appData.postInstaller){
      for(const e of Object.keys(appData.postInstaller)){
        let ent = appData.postInstaller[e];
        if(ent == 'link') ent = appData.documents[e];
        if(!ent) continue;

        const owner = entryAppOwner(ent, e);
        if (owner && owner !== this.app_name) continue;

        if(entryRoot(ent, e)){
          await unInstallEntity(e, ent);
        }else{
          await unInstallDocument(e, ent);
        }
      }
    }

    await loopar.unsetApp(this.app_name);
    jobStep("Rebuilding references and foreign keys", 90);
    await loopar.buildRefs();
    await syncForeignKeys(loopar.db);
    console.log(`App ${this.app_name} uninstalled successfully!`);
    return `App ${this.app_name} uninstalled successfully!`;
  }

  /**
   * Clones `repo` into apps/<App.name>, NOT apps/<repo-name>. The whole
   * framework (installer, uploads, git actions, entity paths) resolves an app
   * as apps/<app_name>, so the folder must match installer.json App.name
   * regardless of what the remote repository is called.
   *
   * `cloneInto(repo, dest, cwd)` runs the actual clone; the default uses the
   * machine's git credentials (fine for public repos).
   */
  async clone(repo, cloneInto = (r, dest) => loopar.git().clone(r, dest)) {
    const appsDir = loopar.makePath(loopar.pathRoot, 'apps');
    const tmpName = `.clone-${Date.now()}`;
    const tmpPath = path.join(appsDir, tmpName);

    await cloneInto(repo, tmpName, appsDir);

    try {
      const installerPath = path.join(tmpPath, 'installer.json');
      if (!fs.existsSync(installerPath)) {
        loopar.throw({ status: 422, code: 'NOT_A_LOOPAR_APP', title: 'Get App',
          message: `${repo} has no installer.json at its root — it is not a Loopar app.` });
      }

      const name = JSON.parse(fs.readFileSync(installerPath, 'utf8'))?.App?.name;
      if (!name || name !== path.basename(name) || name.startsWith('.')) {
        loopar.throw({ status: 422, code: 'INVALID_APP_NAME', title: 'Get App',
          message: `installer.json in ${repo} has a missing or invalid App.name (${JSON.stringify(name)}).` });
      }

      const target = path.join(appsDir, name);
      if (fs.existsSync(target)) {
        loopar.throw({ status: 409, code: 'APP_EXISTS', title: 'Get App',
          message: `App '${name}' already exists at apps/${name}.` });
      }

      await fs.promises.rename(tmpPath, target);
      return name;
    } catch (e) {
      await fs.promises.rm(tmpPath, { recursive: true, force: true });
      throw e;
    }
  }

  async install(reinstall = false) {
    const header = readAppHeader(this.app_name);
    this.#assertInstallable(header);
    await this.#installRequirements(header);

    // A fresh install (the app had nothing here) is undone when it fails; an
    // update is not: the app already holds real data. Not for the framework
    // itself (the setup wizard): there is no workspace to go back to.
    const fresh = !!loopar.__installed__ && this.app_name !== FRAMEWORK_APP
      && await loopar.appStatus(this.app_name) !== "installed";

    // An installed site gets a local snapshot first: an update that breaks
    // half-way has a point to go back to (Backups page / yarn backup restore).
    let snapshot = null;
    if (loopar.__installed__ && loopar.tenantId) {
      snapshot = await this.#safetySnapshot(reinstall ? "updating" : "installing");
    }
    try {
      return await this.#install(reinstall);
    } catch (error) {
      if (fresh) await this.#undoFailedInstall(error, snapshot);
      else this.#explainFailedUpdate(error, snapshot);
      throw error;
    } finally {
      loopar.installingApp = null;
    }
  }

  /**
   * The snapshot before changing the app (once per job): its file, or null
   * when none could be taken. That is said in the job's log, so nobody
   * counts on a way back that doesn't exist.
   */
  async #safetySnapshot(verb) {
    const taken = await jobOnce("safety-snapshot", async () => {
      jobStep(`Taking a safety snapshot before ${verb} ${this.app_name}`, 2);
      const { safetySnapshot } = await import("../../../../../../core/backup/core-ops.js");
      const result = await safetySnapshot(loopar.tenantId, `before ${verb} ${this.app_name}`);
      if (result.error) jobLog(`No safety snapshot could be taken: ${result.error}`, "warn");
      return result;
    });
    return taken?.file ?? null;
  }

  /**
   * A fresh install that failed half-way is taken back out with the
   * uninstall code: the tenant returns to where it was before. The
   * requirements installed first stay (each finished its own install).
   */
  async #undoFailedInstall(error, snapshot) {
    const reason = error?.message || String(error);
    jobLog(`Install failed: ${reason}`, "error");
    jobStep(`Undoing the partial install of ${this.app_name}`);
    try {
      await this.#unInstall();
      loopar.installingApp = null;
      await loopar.build();
      jobLog(`The partial install of ${this.app_name} was undone`);
      error.message = `${reason} The install was undone: the workspace is as it was before.`;
    } catch (undoError) {
      console.error(`[installer] undoing ${this.app_name} failed:`, undoError?.message || undoError);
      error.message = snapshot
        ? `${reason} Undoing it failed too (${undoError?.message || undoError}): restore the snapshot taken before the install (${path.basename(String(snapshot))}) from Backups.`
        : `${reason} Undoing it failed too (${undoError?.message || undoError}), and there is no snapshot from before it.`;
      if (snapshot) error.link = { label: "Open Backups", to: "/desk/Backups/view" };
    }
  }

  /** An update that failed is left as it is: the way back is the caller's choice. */
  #explainFailedUpdate(error, snapshot) {
    const reason = error?.message || String(error);
    if (snapshot) {
      error.message = `${reason} Nothing was undone: retry the update, or restore the snapshot taken before it (${path.basename(String(snapshot))}) from Backups.`;
      error.link = { label: "Open Backups", to: "/desk/Backups/view" };
    } else {
      error.message = `${reason} Nothing was undone, and no snapshot could be taken before it (see the log): retry the update.`;
    }
  }

  /**
   * In production a template installs as it is only in the template host
   * tenant (the demos); every other tenant gets a copy of it (provisioning).
   * A copy only installs in the tenant it was created for.
   */
  #assertInstallable(header) {
    if (!header) return;
    if (isTemplateHeader(header) && process.env.NODE_ENV === "production" && !isTemplateHostTenant()) {
      loopar.throw({
        status: 409, code: "APP_IS_TEMPLATE", title: "Install",
        message: `"${this.app_name}" is a website template: it installs as it is only in the template host tenant (demos); customer sites are copies created by provisioning.`,
      });
    }
    if (belongsToOtherTenant(header)) {
      loopar.throw({ status: 403, code: "APP_OF_OTHER_TENANT", title: "Install", message: `App "${this.app_name}" belongs to another workspace.` });
    }
  }

  /**
   * Installs `appName` in this tenant when it is available on the server and
   * not installed yet. For an app's own migrations: e.g. the framework moving
   * entities it used to ship into a separate app, so tenants holding that data
   * get the new owner before anything reads it. Returns true when it installed.
   */
  async ensureAppInstalled(appName) {
    if (!appName || appName === this.app_name) return false;
    if (await loopar.appStatus(appName) === "installed") return false;
    if (!readAppHeader(appName)) {
      console.warn(`[installer] ${this.app_name}: app "${appName}" is not available on this server, not installed`);
      return false;
    }
    console.log(`[installer] ${this.app_name}: installing "${appName}"`);
    const model = await loadInstaller(appName);
    await model.install(false);
    return true;
  }

  /** Refuses to uninstall an app that other installed apps require. */
  async #assertNoDependents() {
    const dependents = await installedDependents(this.app_name);
    if (dependents.length) {
      loopar.throw({
        status: 409, code: "APP_HAS_DEPENDENTS", title: "Uninstall",
        message: `"${this.app_name}" can't be uninstalled: ${dependents.map((d) => `"${d}"`).join(", ")} ${dependents.length > 1 ? "require" : "requires"} it. Uninstall ${dependents.length > 1 ? "them" : "it"} first.`,
      });
    }
  }

  /** Installs the apps listed in the header's `requires` that aren't installed yet. */
  async #installRequirements(header) {
    const installingRequirements = requirementChain();
    for (const required of parseRequires(header?.requires)) {
      if (required === this.app_name || required === FRAMEWORK_APP) continue;
      if (await loopar.appStatus(required) === "installed") continue;
      if (installingRequirements.has(required)) {
        loopar.throw({ status: 409, code: "REQUIRES_CYCLE", title: "Install", message: `Circular requirement: ${[...installingRequirements, required].join(" → ")}.` });
      }
      if (!readAppHeader(required)) {
        loopar.throw({ status: 424, code: "REQUIRED_APP_MISSING", title: "Install", message: `"${this.app_name}" requires the app "${required}", which is not available on this server.` });
      }

      installingRequirements.add(required);
      try {
        console.log(`[installer] ${this.app_name} requires ${required}: installing it first`);
        jobStep(`${this.app_name} requires ${required}: installing it first`);
        const model = await loadInstaller(required);
        await model.install(false);
      } finally {
        installingRequirements.delete(required);
      }
    }
  }

  async #install(reinstall) {
    loopar.installingApp = this.app_name;
    console.log("Installing App", this.app_name);

    if (this.app_name === 'loopar') {
      if (!this.checkIfAppExists()) {
        await this.clone("https://github.com/alphabitech/loopar.git");
        await loopar.buildRefs();
        return await this.restartInstaller();
      }
    }

    // Install data comes in the installer's order, not the links': the
    // database keys are dropped here and rebuilt by loopar.build() below.
    if (loopar.__installed__) await dropForeignKeys(loopar.db);
    jobStep(`${reinstall ? "Updating" : "Installing"} ${this.app_name}`, 5);
    // The refs serve installed apps only: the app being installed joins them
    // now, so its documents can name its own entities (a Print Format's
    // entity, a link) while they are written.
    await loopar.buildRefs();
    await this.installData(reinstall);
    // Data migrations (core/document/app-migrations.js): after the entities,
    // so the tables already have their new columns. An update runs the ones
    // this tenant hasn't applied; a fresh install has no old data to move.
    if (reinstall) {
      const pending = await pendingMigrations(this.app_name);
      if (pending.length) {
        jobStep(`Running ${pending.length} data migration${pending.length > 1 ? "s" : ""}`, 82);
        await runMigrations(this.app_name, {
          log: (line) => jobLog(line),
          onEach: ({ index, total, description }) => jobProgress(index, total, description),
        });
      }
    } else {
      await baselineMigrations(this.app_name);
    }
    jobStep("Seeding roles", 86);
    await this.seedRoles();

    loopar.installingApp = null;
    
    await loopar.setApp({[this.app_name]: true});
    
    jobStep("Rebuilding the workspace: references, integrity checks, foreign keys", 90);
    await loopar.build();
    console.log(`App ${this.app_name} installed successfully!`);
    return `App ${this.app_name} installed successfully!`;
  }
  
  async getAppFromModule(module) {
    return await loopar.db.getValue('Module', 'app_name', module, {ifNotFound: null});
  }

  /** True when `module` belongs to an app other than the one being installed. */
  async #ownedByOtherApp(module) {
    if (!module) return false;
    const app = await this.getAppFromModule(module).catch(() => null);
    return !!app && !loopar.utils.compare(app, this.app_name);
  }

  /**
   * App that owns an existing record, read from the record itself: its
   * `app_name` / `app` column (Module, Role…) or the app of its `module`.
   * Null when the record doesn't exist or carries no ownership. `App:<name>`
   * records are the apps themselves and are never "owned" by another app.
   */
  async #recordOwner(constructor, name) {
    if (constructor === 'App') return null;
    const value = async (field) => {
      try {
        return await loopar.db.getValue(constructor, field, name, { ifNotFound: null });
      } catch {
        return null; // the table has no such column
      }
    };
    for (const field of ['app_name', 'app']) {
      const app = await value(field);
      if (app) return app;
    }
    const module = await value('module');
    return module ? await this.getAppFromModule(module).catch(() => null) : null;
  }

  /** True when installed app `app` still ships `entryKey` (`Constructor:Name`) as its own. */
  async #appShips(app, entryKey) {
    try {
      const data = await fileManage.getConfigFile('installer', loopar.makePath('apps', app));
      const ent = data?.documents?.[entryKey];
      if (!ent || typeof ent !== 'object') return false;
      const owner = entryAppOwner(ent, entryKey);
      return !owner || loopar.utils.compare(owner, app);
    } catch {
      return false;
    }
  }

  async installData(reinstall = false) {
    const moduleRoute = loopar.makePath('apps', this.app_name);
    let appData = await fileManage.getConfigFile('installer', moduleRoute);

    // Renames recorded by this app (apps/<app>/renames.json): the files were
    // renamed once in the repo, but each tenant's database still has the old
    // names. Replay them before anything reads the schema from the files:
    // ensureFrameworkColumns (below) would otherwise alter the table that
    // still carries the old name to the shape of whatever entity the files
    // now call that way. Idempotent.
    for (const rename of readRenameRecords(loopar.makePath('apps', this.app_name))) {
      try {
        const report = await applyRenameToDatabase(rename);
        if (report.meta || report.table) {
          console.log([`Renamed ${rename.type}: "${rename.from}" → "${rename.to}"`, report]);
        }
      } catch (e) {
        console.error(`[installer] rename ${rename.from} → ${rename.to} failed:`, e.message);
      }
    }

    if (reinstall) {
      await this.ensureFrameworkColumns();

      const fsEntities = new Set(
        loopar.getEntities(this.app_name).map(e => e.name)
      );

      // Every listed document counts, inline ones too: a Controller Builder
      // shipped inline (e.g. "Controller Builder:Contact") whose .json was
      // later written to disk is not drift, and regenerating the snapshot
      // from a tenant DB mid-update pulls in other apps' records.
      const snapshotEntities = new Set(
        Object.entries(appData?.documents || {})
          .filter(([, v]) => v && typeof v === 'object')
          .map(([k]) => k.split(':').slice(1).join(':'))
          .filter(Boolean)
      );
      const hasDrift = [...fsEntities].some(name => !snapshotEntities.has(name));

      if (hasDrift) {
        console.log(
          `[installer] installer.json is stale for "${this.app_name}" — regenerating snapshot before update`
        );
        const app = await loopar.getDocument("App", this.app_name);
        await app.buildInstaller();
        appData = await fileManage.getConfigFile('installer', moduleRoute);
      }
    }

    const installEntity = async (e, ent) => {
      const [constructor, name] = e.split(':');
      const owner = entryAppOwner(ent, e);

      // The installer.json lists entries as `Constructor:Name` (e.g.
      // "Entity:Module"). If the meta-entity referenced by `constructor`
      // isn't registered in refs — usually because its FS JSON carries a
      // `__deleted_at__` tombstone and getEntities() skipped it — we can't
      // hydrate the doc and the whole update would 404. Skip with a loud
      // log so the operator can clear the tombstone and re-run instead of
      // aborting the entire update mid-flight.
      if (!loopar.getRef(constructor)) {
        console.warn(
          `[installer] skipping ${e}: meta-entity "${constructor}" not found in refs ` +
          `(check apps/<app>/modules/<module>/<core>/${constructor.toLowerCase()}/${constructor.toLowerCase()}.json — is __deleted_at__ set?)`
        );
        return;
      }

      if(!owner || owner == this.app_name){
        const entityData = await this.getDocumentData(name, entryRoot(ent, e));
        // getConfigFile answers {} for a missing file: that is "no data", not
        // an empty document (it would insert a row with a NULL name).
        // The file declares which builder owns it. An entry under another
        // constructor (a stale snapshot listing `Entity:X` next to
        // `Page Builder:X`) would open it with the wrong class and generate
        // its model/controller under the wrong type folder (entities/ instead
        // of pages/): skip it.
        const declared = entityData?.__ENTITY__;
        if (declared && String(declared).toLowerCase() !== String(constructor).toLowerCase()) {
          console.warn(`[installer] skipping ${e}: its file declares "${declared}", not "${constructor}" (stale installer.json entry)`);
          jobLog(`Skipped ${e}: declared as ${declared}`, 'warn');
          return;
        }

        if(entityData && Object.keys(entityData).length){
          let doc = await loopar.getDocument(constructor, name, entityData, { ifNotFound: null });
          const wasFound = !!doc;
          // A row left behind by another app that no longer ships this name
          // (renamed/removed, or an old name-only overwrite) is taken over:
          // always written, so it moves to this app. The preflight already
          // refused names another installed app still ships.
          // The stored module (not doc's: entityData overrides it with ours).
          const storedModule = wasFound
            ? await loopar.db.getValue(constructor, 'module', name, { ifNotFound: null }).catch(() => null)
            : null;
          const reclaimed = wasFound && await this.#ownedByOtherApp(storedModule);
          if (!doc) doc = await loopar.newDocument(constructor, entityData);

          console.log([reclaimed ? "Reclaiming......." : wasFound ? "Updating......." : "Installing.......", constructor, name]);
          if (!wasFound || reinstall || reclaimed) {
            jobLog(`${reclaimed ? "Reclaimed" : wasFound ? "Updated" : "Installed"} ${constructor}:${name}`);
            await doc.save({ validate: false, reload: false });
          }
        }else{
          console.log([`No data found for ${constructor}:${name}, skipping...`]);
        }
      }else{
        loopar.throw(`App ${this.app_name} require ${owner}:${name} to be installed first`);
      }
    }

    const installDocument = async (e, ent, postInstall=false) => {
      const [constructor, name] = e.split(':');

      const { id: _ignoredSnapshotId, ...cleanEnt } = ent;

      const existing = await loopar.getDocument(
        constructor, name, cleanEnt, { ifNotFound: null }
      );

      // A record another app owned and no longer ships (e.g. a module moved
      // from the framework into a separate app) is taken over, the same rule
      // installEntity follows for entities. The preflight already refused
      // records another installed app still ships.
      const previousOwner = existing ? await this.#recordOwner(constructor, name).catch(() => null) : null;
      const reclaimed = !!previousOwner && !loopar.utils.compare(previousOwner, this.app_name);

      if (!existing) {
        console.log([`Inserting ${constructor}:${name}`]);
        jobLog(`Inserted ${constructor}:${name}`);
        const doc = await loopar.newDocument(constructor, { ...cleanEnt, __document_status__: "Active" });
        doc.name = name;
        await doc.save({ validate: false });
      } else if (reclaimed) {
        console.log([`Reclaiming ${constructor}:${name} from ${previousOwner}`]);
        jobLog(`Reclaimed ${constructor}:${name} from ${previousOwner}`);
        await existing.save({ validate: false, forceChildren: true });
      } else if (reinstall || postInstall) {
        console.log([`Updating ${constructor}:${name}`]);
        jobLog(`Updated ${constructor}:${name}`);
        await existing.save({ validate: false, forceChildren: postInstall });
      }
    }

    // Preflight: every entry owned by another app must already exist in this
    // tenant. Checked up-front so a missing dependency aborts BEFORE anything
    // is written (otherwise App:<name> gets inserted and the app looks
    // installed while half its documents are missing).
    const missing = [];
    for (const e of Object.keys(appData.documents)) {
      const ent = appData.documents[e];
      if (!ent || (typeof ent === 'object' && Object.keys(ent).length === 0)) continue;

      const owner = entryAppOwner(ent, e);
      if (!owner || owner === this.app_name) continue;

      const [constructor, name] = e.split(':');
      if (!await loopar.db.count(constructor, name)) missing.push({ owner, e });
    }

    // Preflight: entity names are unique per tenant. An entity this app ships
    // must not take a name another installed app still ships — installing it
    // would overwrite that app's record (and on update it silently did).
    const taken = [];
    for (const e of Object.keys(appData.documents)) {
      const ent = appData.documents[e];
      if (!ent || typeof ent !== 'object' || !entryRoot(ent, e)) continue;

      const owner = entryAppOwner(ent, e);
      if (owner && owner !== this.app_name) continue;

      const [constructor, name] = e.split(':');
      let module = null;
      try {
        module = await loopar.db.getValue(constructor, 'module', name, { ifNotFound: null });
      } catch {
        continue; // meta table without `module` (or not created yet)
      }

      const ownerApp = module && await this.getAppFromModule(module).catch(() => null);
      if (!ownerApp || loopar.utils.compare(ownerApp, this.app_name)) continue;

      const stillShipped = loopar.getEntities(ownerApp)
        .some(ref => loopar.utils.toEntityKey(ref.name) === loopar.utils.toEntityKey(name));
      if (stillShipped) taken.push(`${e} (owned by "${ownerApp}")`);
    }

    // Same rule for inline documents (Module, Role, …): a record that already
    // belongs to another installed app wins. Without this, a hand-written
    // installer.json shipping e.g. "Module:mail" re-saved loopar's own module
    // with this app's data and moved it (and every entity in it) to this app.
    for (const e of Object.keys(appData.documents)) {
      const ent = appData.documents[e];
      if (!ent || typeof ent !== 'object' || entryRoot(ent, e)) continue;

      const owner = entryAppOwner(ent, e);
      if (owner && owner !== this.app_name) continue;

      const [constructor, ...rest] = e.split(':');
      const name = rest.join(':');
      const ownerApp = await this.#recordOwner(constructor, name);
      if (!ownerApp || loopar.utils.compare(ownerApp, this.app_name)) continue;
      if (await this.#appShips(ownerApp, e)) taken.push(`${e} (owned by "${ownerApp}")`);
    }
    // The framework always wins: its names are reserved, so an app that took
    // one can't block installing or updating loopar. The records are reclaimed
    // below (installEntity / installDocument) and the app that still ships
    // them is refused on its next update until it renames them.
    if (taken.length && this.app_name === FRAMEWORK_APP) {
      console.warn(
        `[installer] loopar reclaims documents that belonged to other apps: ${taken.join(', ')}. ` +
        `Those apps must rename them before their next update.`
      );
      taken.length = 0;
    }
    if (taken.length) {
      loopar.throw({
        status: 409, code: 'NAME_TAKEN', title: 'Install',
        message:
          `App "${this.app_name}" ships documents whose names already belong to another app: ` +
          `${taken.join(', ')}. Names are unique per tenant: rename them in "${this.app_name}".`,
      });
    }

    if (missing.length) {
      const owners = [...new Set(missing.map(m => m.owner))].join(', ');
      loopar.throw({
        status: 409, code: 'MISSING_DEPENDENCY', title: 'Install',
        message:
          `App "${this.app_name}" needs these documents from ${owners}, not present in this tenant: ` +
          `${missing.map(m => m.e).join(', ')}. Update ${owners} first (they may be newer than the installed version).`,
      });
    }

    // A name the app now ships under another type (a page turned into an
    // entity…): drop the old record before installing the new one.
    if (reinstall) await this.replaceRetyped(appData);

    const documentKeys = Object.keys(appData.documents);
    let installed = 0;
    // Overall progress (background job): the documents fill 8-70%.
    jobStep(`Writing ${documentKeys.length} documents`, 8);
    jobRange(8, 70);
    const failAfter = injectedFailureAfter(this.app_name, documentKeys.length);
    for (const e of documentKeys) {
      const ent = appData.documents[e];
      if (failAfter != null && installed >= failAfter) {
        throw new Error(`Injected failure after ${installed} documents (sites/${loopar.tenantId}/.fail-install).`);
      }
      jobProgress(++installed, documentKeys.length, e);

      if (!ent || (typeof ent === 'object' && Object.keys(ent).length === 0)) continue;

      const owner = entryAppOwner(ent, e);
      if (owner && owner !== this.app_name) continue; // verified in preflight

      if(entryRoot(ent, e)){
        await installEntity(e, ent);
      }else{
        await installDocument(e, ent);
      }
    }

    if(appData.postInstaller){
      const linkKeys = Object.keys(appData.postInstaller);
      let linked = 0;
      jobStep("Linking documents", 70);
      jobRange(70, 80);
      for(const e of linkKeys){
        let ent = appData.postInstaller[e];
        if(ent == 'link') ent = appData.documents[e];
        jobProgress(++linked, linkKeys.length, e);

        if(!ent) continue;

        const owner = entryAppOwner(ent, e);
        if (owner && owner !== this.app_name) continue;

        if(entryRoot(ent, e)){
          await installEntity(e, ent, true);
        }else{
          await installDocument(e, ent, true);
        }
      }
    }

    await this.ensureFrameworkColumns();

    // An update also takes away what the app no longer ships.
    if (reinstall) {
      jobStep("Removing what the app no longer ships", 82);
      await this.pruneRemoved(appData);
    }

    const topLevelVersion = appData?.App?.version;
    if (topLevelVersion) {
      try {
        const installedApp = await loopar.getDocument("App", this.app_name, null, { ifNotFound: null });
        if (installedApp && installedApp.version !== topLevelVersion) {
          installedApp.version = topLevelVersion;
          await installedApp.save({ validate: false });
        }
      } catch (e) {
        console.warn(`[installer] could not sync App.version for ${this.app_name}:`, e.message);
      }
    }

    return `App ${this.app_name} installed successfully!`;
  }

  /**
   * Structure documents (entities and builder records) of this app whose name
   * the installer.json now ships under another type — e.g. the App Manager
   * page that became a virtual entity. Names are unique per tenant, and
   * pruneRemoved keeps any record whose name is still on disk, so the record
   * of the old type is removed here, before the new one is installed.
   * Returns the removed `Constructor:Name` keys.
   */
  async replaceRetyped(appData) {
    const key = (v) => loopar.utils.toEntityKey(String(v ?? ''));
    const shippedAs = new Map();
    for (const [k, ent] of Object.entries(appData?.documents || {})) {
      if (!entryRoot(ent, k)) continue;
      const [constructor, ...name] = String(k).split(':');
      shippedAs.set(key(name.join(':')), key(constructor));
    }
    if (!shippedAs.size) return [];

    const modules = (await loopar.db.getAll('Module', ['name'], { app_name: this.app_name })).map((m) => m.name);
    if (!modules.length) return [];

    const types = ['Entity'];
    if (loopar.getRef('Builder', false)) {
      for (const b of await loopar.db.getAll('Builder', ['name'])) types.push(b.name);
    }

    const removed = [];
    for (const type of [...new Set(types)]) {
      const ref = loopar.getRef(type, false);
      if (!ref || !(ref.__FIELDS__ || []).includes('module')) continue;
      const rows = await loopar.db.getAll(type, ['name'], { module: { [Op.in]: modules } });
      for (const row of rows) {
        const now = shippedAs.get(key(row.name));
        if (!now || now === key(type)) continue;
        // Only the row: the document's delete() would resolve the name to the
        // new type (refs are keyed by name) and rewrite the old files on disk.
        console.warn([`[installer] ${this.app_name} now ships "${row.name}" as another type: removing its ${type} record`]);
        await loopar.db.deleteRow(type, row.name, { force: true });
        removed.push(`${type}:${row.name}`);
      }
    }
    return removed;
  }

  /**
   * Update cleanup. Structure the app used to ship and no longer does —
   * entities, builder documents (pages, print formats, forms…) and modules
   * of this app that are neither listed in installer.json nor present on
   * disk — is removed from the tenant. Only the records that describe the
   * structure go: the data table of a removed entity is left as it is.
   * Returns the removed `Constructor:Name` keys.
   */
  async pruneRemoved(appData) {
    const key = (v) => loopar.utils.toEntityKey(String(v ?? ''));
    const entryKey = (k) => {
      const [constructor, ...name] = String(k).split(':');
      return `${key(constructor)}:${key(name.join(':'))}`;
    };
    const shipped = new Set([
      ...Object.keys(appData?.documents || {}),
      ...Object.keys(appData?.postInstaller || {}),
    ].map(entryKey));
    const onDisk = new Set(loopar.getEntities(this.app_name).map((e) => key(e.name)));
    const kept = (constructor, name) => shipped.has(`${key(constructor)}:${key(name)}`) || onDisk.has(key(name));

    const modules = (await loopar.db.getAll('Module', ['name'], { app_name: this.app_name })).map((m) => m.name);
    if (!modules.length) return [];

    // Every kind of structure document: entities and each builder's records.
    const types = ['Entity'];
    if (loopar.getRef('Builder', false)) {
      for (const b of await loopar.db.getAll('Builder', ['name'])) types.push(b.name);
    }

    const removed = [];
    const remove = async (type, name) => {
      const doc = await loopar.getDocument(type, name, null, { ifNotFound: null });
      if (!doc) return;
      await doc.delete({ sofDelete: false, force: true, build: false });
      removed.push(`${type}:${name}`);
    };

    for (const type of [...new Set(types)]) {
      const ref = loopar.getRef(type, false);
      if (!ref || !(ref.__FIELDS__ || []).includes('module')) continue;
      const rows = await loopar.db.getAll(type, ['name', 'module'], { module: { [Op.in]: modules } });
      for (const row of rows) {
        if (kept(type, row.name)) continue;
        console.warn([`[installer] ${this.app_name} no longer ships ${type}:${row.name}: removing it`]);
        await remove(type, row.name);
      }
    }

    // A module the app no longer ships, once nothing is left in it.
    for (const module of modules) {
      if (kept('Module', module)) continue;
      let left = 0;
      for (const type of [...new Set(types)]) {
        const ref = loopar.getRef(type, false);
        if (ref && (ref.__FIELDS__ || []).includes('module')) left += await loopar.db.count(type, { module });
      }
      if (left) continue;
      console.warn([`[installer] ${this.app_name} no longer ships Module:${module}: removing it`]);
      await remove('Module', module);
    }

    if (removed.length) console.log([`[installer] ${this.app_name}: removed ${removed.length} document(s) it no longer ships`, removed]);
    return removed;
  }

  async ensureFrameworkColumns() {
    const entities = loopar
      .getEntities(this.app_name)
      .filter(e => !e.__deleted_at__)
      .filter(e => {
        const ref = loopar.getRef(e.name);
        if (!ref || ref.is_static || ref.is_single || ref.is_virtual) return false;
        return true;
      });

    for (const entity of entities) {
      try {
        const ref = loopar.getRef(entity.name);
        await loopar.db.makeTable(entity.name, ref.__FIELDS_STRUCTURE__ || ref.doc_structure || []);
      } catch (e) {
        console.error(`[ensureFrameworkColumns] ${entity.name}:`, e.message);
      }
    }
  }

  async ensureAuditFields() {
    return this.ensureFrameworkColumns();
  }

}