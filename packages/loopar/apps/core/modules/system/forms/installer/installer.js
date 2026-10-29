import path from "pathe";
import fs from "fs";
import { loopar, fileManage } from "loopar";
import BaseDocument from "../../../../../../core/document/base-document.js";
import { readRenameRecords, applyRenameToDatabase } from "../../../../../../core/document/entity-rename.js";

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
   * Grant: { document, action, scope = 'all' | 'own', deny = 0 }.
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

  async defaultRoles() {
    if (this.constructor.defaultRoles === false) return [];
    const label = loopar.utils.Capitalize(String(this.app_name).replace(/[-_]+/g, ' '));
    const app = `App:${this.app_name}`;
    return [
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

  /** Roles this app defines: convention defaults + `static roles` (declared wins by name). */
  async appRoles(declared = this.constructor.roles) {
    const byName = new Map();
    for (const r of await this.defaultRoles()) byName.set(r.name, r);
    for (const r of (Array.isArray(declared) ? declared : [])) if (r?.name) byName.set(r.name, r);
    return [...byName.values()];
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
          scope: g.scope === "own" ? "own" : "all",
        });
      }
    }
  }

  async getDocumentData(document, root) {
    return await fileManage.getConfigFile(document, root);
  }

  getNameToFileName(name) {
    return loopar.utils.decamelize(name.replaceAll(/\s/g, ''), { separator: '-' });
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

    // installingApp short-circuits loopar.build(); a failure that doesn't go
    // through loopar.throw (e.g. a SqliteError) must not leave it stuck.
    try {
      return await this.#unInstall();
    } finally {
      loopar.installingApp = null;
    }
  }

  async #unInstall() {

    console.log("Uninstalling App", this.app_name);
    loopar.installingApp = this.app_name;

    const moduleRoute = loopar.makePath('apps', this.app_name);
    const appData = await fileManage.getConfigFile('installer', moduleRoute);

    const unInstallEntity = async (e, ent) => {
      const [constructor, name] = e.split(':');

      if(await loopar.db.hasEntity(constructor, name)){
        const entityData = await this.getDocumentData(name, entryRoot(ent, e));
        if(entityData){
          const doc = await loopar.getDocument(constructor, name);
          console.warn([`Uninstalling ${constructor}:${name}`]);
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
        const doc = await loopar.getDocument(constructor, name);
        await doc.delete({ sofDelete: false, force: true, build: false });
      }
    }

    for (const e of Object.keys(appData.documents).reverse()) {
      const ent = appData.documents[e];
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

    await loopar.unsetApp(this.name);
    await loopar.buildRefs();
    console.log(`App ${this.app_name} uninstalled successfully!`);
    return `App ${this.app_name} uninstalled successfully!`;
  }

  /**
   * Clones `repo` into apps/<App.name>, NOT apps/<repo-name>. The whole
   * framework (installer, uploads, git actions, entity paths) resolves an app
   * as apps/<app_name>, so the folder must match installer.json App.name
   * regardless of what the remote repository is called.
   */
  async clone(repo) {
    const appsDir = loopar.makePath(loopar.pathRoot, 'apps');
    const tmpName = `.clone-${Date.now()}`;
    const tmpPath = path.join(appsDir, tmpName);

    console.log(["Cloning", repo]);
    await loopar.git().clone(repo, tmpName);

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
    try {
      return await this.#install(reinstall);
    } finally {
      loopar.installingApp = null;
    }
  }

  async #install(reinstall) {
    loopar.installingApp = this.app_name;
    console.log("Installing App", this.app_name);

    if (this.app_name === 'loopar') {
      if (!this.checkIfAppExists()) {
        await this.clone("https://github.com/alphabit-technology/loopar.git");
        await loopar.buildRefs();
        return await this.restartInstaller();
      }
    }

    await this.installData(reinstall);
    await this.seedRoles();

    loopar.installingApp = null;
    
    await loopar.setApp({[this.app_name]: true});
    
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

    if (reinstall) {
      await this.ensureFrameworkColumns();

      const fsEntities = new Set(
        loopar.getEntities(this.app_name).map(e => e.name)
      );

      const snapshotEntities = new Set(
        Object.entries(appData?.documents || {})
          .filter(([, v]) => v && (v.__root__ || v.root || v.doc || v.__app__ || v.app))
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

    // Renames recorded by this app (apps/<app>/renames.json): the files were
    // renamed once in the repo, but each tenant's database still has the old
    // names. Replay them before installing documents. Idempotent.
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
        if(entityData){
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
          (!wasFound || reinstall || reclaimed) && await doc.save({ validate: false, reload: false });
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

      if (!existing) {
        console.log([`Inserting ${constructor}:${name}`]);
        const doc = await loopar.newDocument(constructor, { ...cleanEnt, __document_status__: "Active" });
        doc.name = name;
        await doc.save({ validate: false });
      } else if (reinstall || postInstall) {
        console.log([`Updating ${constructor}:${name}`]);
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

    for (const e of Object.keys(appData.documents)) {
      const ent = appData.documents[e];

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
      for(const e of Object.keys(appData.postInstaller)){
        let ent = appData.postInstaller[e];
        if(ent == 'link') ent = appData.documents[e];

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