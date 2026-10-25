import { fileManage, loopar } from 'loopar';
import {Op} from 'db-env';

function queueKey(constructor, name) {
  return `${constructor}:${name}`;
}

function stripPersistedIds(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return doc;
  const { id: _id, parent_id: _pid, ...rest } = doc;
  for (const key of Object.keys(rest)) {
    const value = rest[key];
    if (Array.isArray(value)) {
      rest[key] = value.map(stripPersistedIds);
    }
  }
  return rest;
}

/**
 * @param {Object} appData - { key: { requires?: string[], doc?: any, ...rest } }
 * @param {string[]} [refs] - Subset of keys to start from. Defaults to all.
 * @returns {Object} { key: docOrEntryWithoutRequires } in install order.
 */
function topologicalSort(appData, refs = null) {
  const result = {};
  const visited = new Set();

  const visit = (key) => {
    if (visited.has(key)) return;
    visited.add(key);

    const ent = appData[key];
    if (!ent) return;

    if (Array.isArray(ent.requires)) {
      for (const r of ent.requires) visit(r);
    }

    if (result[key]) return;

    if (ent.doc) {
      result[key] = ent.doc;
    } else {
      const { requires: _ignored, ...rest } = ent;
      result[key] = rest;
    }
  };

  for (const key of (refs || Object.keys(appData))) visit(key);
  return result;
}

class InstallerBuilder {
  /**
   * @param {string} app
   * @param {string} version
   * @param {InstallerBuilder} [postInstaller]
   */
  constructor(app, version, postInstaller = null) {
    this.app = app;
    this.version = version;

    this.modules = [];
    this.entities = [];
    this.entitiesName = [];

    this.Queues = {};
    this.PostInstallerQueue = {};

    this.postInstaller = postInstaller || this;
  }

  async initialize() {
    await this.loadModules();
    this.loadEntities();
  }

  async loadModules() {
    const modules = await loopar.db.getAll("Module", ["name"], { app_name: this.app });
    this.modules = modules.map(m => m.name);
  }

  loadEntities() {
    const mapEntity = (entity, extra = {}) => {
      const parent = loopar.getRef(entity.__ENTITY__);
      return {
        sortKey: [parseInt(parent?.id) || 0, parseInt(entity.id) || 0],
        id: parseInt(entity.id),
        __ENTITY__: entity.__ENTITY__ || "Entity",
        __NAME__: entity.name,
        __APP__: entity.__APP__,
        __ROOT__: entity.entityRoot,
        ...extra,
      };
    };

    const sortFn = (a, b) => {
      if (a.sortKey[0] !== b.sortKey[0]) return a.sortKey[0] - b.sortKey[0];
      return a.sortKey[1] - b.sortKey[1];
    };

    // Single pass over getEntities() — partition into own vs foreign
    // include_in_installer, dedup foreign by name against own via Set.
    const all = loopar.getEntities();
    const own = [];
    const foreignCandidates = [];
    for (const e of all) {
      if (loopar.utils.compare(e.__APP__, this.app)) own.push(e);
      else if (e.include_in_installer === 1) foreignCandidates.push(e);
    }

    const ownNamesSet = new Set(own.map(e => e.name));

    this.entities = own.map(e => mapEntity(e)).sort(sortFn);

    // Pre-resolve `appField` once per foreign entity (avoids re-fetching
    // and re-parsing doc_structure inside build()). Foreigns without an
    // `app` Select get dropped here — without one we can't scope records
    // to this.app, and the entity stays implicit (framework data).
    this.foreignIncluded = foreignCandidates
      .filter(e => !ownNamesSet.has(e.name))
      .map(e => {
        const docStructure = loopar.utils.JSONparse(e.doc_structure, []);
        const appField = this.findSelectFieldFor(docStructure, "App");
        return appField
          ? mapEntity(e, { __IS_FOREIGN__: true, appField })
          : null;
      })
      .filter(Boolean);

    this.entitiesName = this.entities.map(e => e.__NAME__);
    this.foreignEntitiesName = this.foreignIncluded.map(e => e.__NAME__);
  }

  fieldIsModelReference(field) {
    if (![SELECT, FORM_TABLE].includes(field.element)) return false;
    const opts = field.data?.options;
    if (typeof opts !== 'string' || !opts) return false;
    const lines = opts.split("\n");
    return !(lines.length > 1 || lines[0] === "");
  }

  findFieldInStructure(elements, criteria) {
    for (const el of elements) {
      if (criteria(el)) return el.data?.name || true;
      if (Array.isArray(el?.elements)) {
        const found = this.findFieldInStructure(el.elements, criteria);
        if (found) return found;
      }
    }
    return false;
  }

  findSelectFieldFor(elements, entityName) {
    return this.findFieldInStructure(
      elements,
      el => el.element === SELECT && el?.data?.options === entityName
    );
  }

  checkIfHaveAnEntity(els, entityName) { return this.findSelectFieldFor(els, entityName); }
  fieldIsModel(field) { return this.fieldIsModelReference(field); }

  async queueEntity(entity) {
    const constructor = loopar.getRef(entity.__ENTITY__ || "Entity");
    const key = queueKey(constructor.__NAME__, entity.__NAME__);
    if (this.Queues[key]) return;

    this.Queues[key] = {};

    if (loopar.utils.compare(entity.__APP__, this.app)) {
      const ent = await loopar.getDocument(
        constructor.__NAME__ || "Entity",
        entity.__NAME__,
        {},
        { ifNotFound: false, parse: true }
      );

      const Doc = ent
        ? await ent.rawValues()
        : fileManage.getConfigFile(entity.__NAME__, entity.__ROOT__);

      if (Doc) {
        const requires = await this.getRequires(constructor, Doc);

        if (constructor.__NAME__ !== entity.__NAME__ && constructor.__NAME__ !== "Entity") {
          requires.unshift(queueKey(constructor.__ENTITY__, constructor.__NAME__));
        }

        this.Queues[key] = {
          requires: Array.from(new Set(requires)),
          __root__: entity.__ROOT__
        };
      } else {
        console.log([`[buildInstaller] No data for ${key} (DB miss + file missing)`]);
      }

      await this.buildDocuments(entity);
    } else {
      this.Queues[key] = {
        requires: [],
        __app__: entity.__APP__
      };
    }
  }

  async queue(Entity, Doc) {
    const isEntity = loopar.getRef(Doc?.name);
    if (isEntity && isEntity.__ENTITY__ == Entity.__NAME__) {
      return this.queueEntity(isEntity);
    }

    const key = queueKey(Entity.__NAME__, Doc?.name);
    if (this.Queues[key]) return;

    this.Queues[key] = {};
    const requires = await this.getRequires(Entity, Doc);
    this.Queues[key] = {
      requires: Array.from(new Set(requires)),
      doc: stripPersistedIds(Doc)
    };
  }

  async getRequires(entity, doc) {
    const reqs = [];

    const checkRequires = async (els, d) => {
      for (const el of els) {
        if (el.data && this.fieldIsModelReference(el)) {
          const relatedEntity = loopar.getRef(el.data.options);
          if (!relatedEntity) continue;

          await this.queueEntity(relatedEntity);

          if (relatedEntity.__NAME__ != doc?.name && doc?.name == "Entity") {
            reqs.push(queueKey(relatedEntity.__ENTITY__, relatedEntity.__NAME__));
          }

          if (el.element === SELECT) {
            const refKey = await this._resolveSelectRef(el, d, doc, relatedEntity, entity);
            if (refKey) reqs.push(refKey);
          }

          if (el.element === FORM_TABLE) {
            await this._resolveFormTableRef(el, d, entity, relatedEntity);
          }
        }

        if (Array.isArray(el?.elements)) {
          await checkRequires(el.elements, d);
        }
      }
    };

    const entityData = await fileManage.getConfigFile(entity.__NAME__, entity.__ROOT__);
    await checkRequires(loopar.utils.JSONparse(entityData.doc_structure, []), doc);

    if (entity.__NAME__ != entity.__ENTITY__) {
      reqs.unshift(queueKey(entity.__ENTITY__, entity.__NAME__));
    }

    await this.queueEntity(entity);
    return reqs;
  }

  /**
   * @returns {Promise<string|null>}
   */
  async _resolveSelectRef(el, d, doc, relatedEntity, entity) {
    if (!d || el.data.options === doc?.name) return null;

    const relatedDoc = await loopar.getDocument(
      el.data.options,
      d[el.data.name],
      null,
      { ifNotFound: false }
    );

    if (!relatedDoc) {
      console.log(['relatedDoc not found', entity.__NAME__, el.data.options, d[el.data.name]]);
      return null;
    }

    const rawValues = await relatedDoc.rawValues();
    await this.queue(relatedEntity, rawValues);
    return queueKey(relatedEntity.__NAME__, rawValues.name);
  }

  async _resolveFormTableRef(el, d, entity, relatedEntity) {
    if (!d) return;

    let raw = d[el.data.name];
    if (raw && typeof raw.then === 'function') raw = await raw;
    if (typeof raw === 'string') {
      try { raw = JSON.parse(raw); } catch { raw = null; }
    }

    let childs;
    if (Array.isArray(raw)) {
      childs = raw;
    } else if (raw == null) {
      childs = [];
    } else {
      console.warn(
        `[builder._resolveFormTableRef] non-array value for FORM_TABLE field "${el.data.name}" ` +
        `on entity "${entity.__NAME__}" (parent doc "${d?.name}", related "${relatedEntity?.__NAME__}"). ` +
        `Got ${typeof raw}; treating as empty. Inspect upstream rawValues / getter for this field.`
      );
      childs = [];
    }

    for (const item of childs) {
      await this.postInstaller.getRequires(relatedEntity, item);
    }

    const parentKey = queueKey(entity.__NAME__, d.name);
    this.postInstaller.PostInstallerQueue[parentKey] =
      this.Queues[parentKey] ? 'link' : d;
  }

  async buildDocuments(entity) {
    const ref = loopar.getRef(entity.__NAME__);
    if (!ref || ref.is_child || ref.is_single) return;

    const include_in_installer = await loopar.db.getValue(
      entity.__ENTITY__ || "Entity",
      "include_in_installer",
      entity.__NAME__
    );
    if (include_in_installer !== 1) return;

    const data = fileManage.getConfigFile(ref.__NAME__, ref.__ROOT__);
    const docStructure = loopar.utils.JSONparse(data.doc_structure, []);

    const moduleField = this.findSelectFieldFor(docStructure, "Module");
    const appField = this.findSelectFieldFor(docStructure, "App");

    const filters = {};

    if (moduleField || appField) {
      if (moduleField) {
        filters[Op.or] = [
          {
            name: { [Op.notIn]: [...this.entitiesName] },
            [moduleField]: { [Op.in]: this.modules }
          },
          {
            name: { [Op.in]: [...this.entitiesName] }
          }
        ];
      }
      if (appField) {
        filters[appField] = this.app;
      }
    } else {
      if (!this.entitiesName.includes(entity.__NAME__)) return;
    }

    if (data.name === "Module") filters.app_name = this.app;
    if (data.name === "App") filters.name = this.app;

    const docs = await loopar.db.getAll(ref.__NAME__, ["*"], filters);

    const sortedDocs = docs
      .sort((a, b) => a.id - b.id)
      .filter(d => d.name !== "Entity");

    for (const doc of sortedDocs) {
      const liveDoc = await loopar.getDocument(
        ref.__NAME__,
        doc.name,
        null,
        { ifNotFound: null }
      );
      const payload = liveDoc ? await liveDoc.rawValues() : doc;
      await this.queue(ref, payload);
    }
  }

  /**
   * Snapshot a Module entry for every module this app's entities belong
   * to, as declared by each entity's `module` field. The folder name
   * (__MODULE__) is only a fallback: it can differ in case from the Module
   * row ("web" folder → "Web" module) and would ship a duplicate module.
   * If a real Module row exists in the DB we snapshot that; otherwise we
   * synthesize a minimal one so the installer can create the row and
   * targetApp() resolves on the target. Entries already queued by
   * buildDocuments (DB-backed) are left untouched.
   */
  async queueModules() {
    const moduleRef = loopar.getRef("Module");
    if (!moduleRef) return;

    const moduleNames = new Set(
      loopar.getEntities(this.app)
        .map(e => e.module || e.__MODULE__)
        .filter(Boolean)
    );

    for (const moduleName of moduleNames) {
      if (this.Queues[queueKey("Module", moduleName)]) continue;

      const liveDoc = await loopar.getDocument(
        "Module", moduleName, null, { ifNotFound: null }
      );
      const payload = liveDoc
        ? await liveDoc.rawValues()
        : {
            name: moduleName,
            description: moduleName,
            app_name: this.app,
            in_sidebar: 1,
          };
      await this.queue(moduleRef, payload);
    }
  }

  /**
   * @param {{dryRun?: boolean}} [options]
   * @returns {Promise<{App: {name: string, version: string}, documents: object, postInstaller: object}>}
   */
  async build({ dryRun = false } = {}) {
    await this.initialize();

    for (const entity of this.entities) {
      await this.queueEntity(entity);
    }
    
    await this.queueModules();

    const app = await loopar.getDocument("App", this.app, null, { ifNotFound: null });
    if (app) await this.queue(loopar.getRef("App"), await app.rawValues());

    for (const [key, value] of Object.entries(this.postInstaller.Queues)) {
      if (!this.Queues[key]) this.Queues[key] = value;
    }

    // Foreign include_in_installer entities: collect records pointing
    // to this.app via the pre-resolved appField. Use liveDoc.rawValues()
    // for parity with buildDocuments — derived/computed fields included.
    for (const entity of this.foreignIncluded) {
      const records = await loopar.db.getAll(entity.__NAME__, ["*"], {
        [entity.appField]: this.app
      });
      for (const record of records) {
        const liveDoc = await loopar.getDocument(
          entity.__NAME__,
          record.name,
          null,
          { ifNotFound: null }
        );
        const payload = liveDoc ? await liveDoc.rawValues() : record;
        await this.queue(entity, payload);
      }
    }

    const snapshot = this.composeSnapshot();
    if (!dryRun) await this.writeSnapshot(snapshot);
    return snapshot;
  }

  composeSnapshot() {
    const docs = topologicalSort(this.Queues);
    const appKey = `App:${this.app}`;
    if (docs[appKey] && typeof docs[appKey] === 'object') {
      docs[appKey] = { ...docs[appKey], version: this.version };
    }

    return {
      App: {
        name: this.app,
        version: this.version,
      },
      documents: docs,
      postInstaller: this.postInstaller.PostInstallerQueue
    };
  }

  async writeSnapshot(snapshot) {
    await fileManage.setConfigFile(
      'installer',
      snapshot,
      loopar.makePath('apps', this.app)
    );
  }
}

/**
 * @param {Object} options
 * @param {string} options.app
 * @param {string} options.version
 * @param {boolean} [options.dryRun=false] - When true, computes the snapshot
 *   but does not write `installer.json`. The snapshot is still returned.
 * @returns {Promise<object>} The composed snapshot.
 */
export async function buildInstaller({app, version, dryRun = false}) {
  const postInstaller = new InstallerBuilder(app, version);
  const installer = new InstallerBuilder(app, version, postInstaller);
  return await installer.build({ dryRun });
}
