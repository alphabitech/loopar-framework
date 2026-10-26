'use strict'
import DynamicField from './dynamic-field.js';
import { loopar } from '../loopar.js';
import { fileManage } from '../file-manage.js';
import { parseDocStructure, stripEphemeralDocStructure, injectCookieIndexes } from './tools.js';
import { FRAMEWORK_OWNED_COLUMN_NAMES } from '../global/audit.js';
import { isHashedSecret } from '../global/secrets.js';
import { nextSeriesName } from './naming-series.js';
import { guardWorkflowState, workflowFor, describeWorkflow } from './workflow.js';
import { computeFormulas, tableRows } from '../global/formula.js';

export default class CoreDocument {
  #fields = {};
  #protectedPassword = "********";

  constructor(props) {
    Object.assign(this, props);
  }

  get fields() {
    return this.#fields;
  }

  get protectedPassword() {
    return this.#protectedPassword
  }

  async onLoad() {

  }

  trigger(event, ...args) {
    if (this[event] && typeof this[event] === 'function') {
      this[event](event, ...args);
    }
  }

  async setApp() {
    const __REF__ = this.__ENTITY__.__REF__;

    if (loopar.installing) {
      this.__APP__ = loopar.installingApp;
      return;
    }

    if (this.__ENTITY__.name === "App") {
      this.__APP__ = this.name;
    } else if (this.is_builder) {
      // Builder entities resolve their app through the module.
      if (this.name === "Entity") {
        this.__APP__ = "loopar";
      } else {
        this.__APP__ ??= await loopar.db.getValue("Module", "app_name", this.module);
      }
    } else if (this.__ENTITY__.name === "Module") {
      this.__APP__ = this.app_name;
    } else {
      if (__REF__?.__APP__) {
        this.__APP__ = __REF__.__APP__;
      } else {
        this.__APP__ ??= await loopar.db.getValue("Module", "app_name", this.__ENTITY__.module);
      }
    }
  }

  async __init__() {
    await this.#makeFields(loopar.utils.JSONparse(this.__ENTITY__.doc_structure, []));

    this.#defineFrameworkOwnedProps();

    if (this.__DATA__ && this.__DATA__.doc_structure) {
      const parsed = JSON.parse(this.__DATA__.doc_structure);
      // Incoming structures (designer save) may carry render-injected
      // payloads (getList rows, preloads, cookie indexes) — don't persist them.
      this.__DATA__.doc_structure = JSON.stringify(
        stripEphemeralDocStructure(parsed.filter(field => (field.data || {}).name !== ID))
      );
    }

    await this.setApp();
    await this.onLoad();
  }

  async getConnectedDocuments() {
    const refs = Object.values(loopar.getRefs());
    const relatedEntities = [];

    for (const ref of refs) {
      const ent = await fileManage.getConfigFile(ref.__NAME__, ref.__ROOT__);
      const fields = loopar.utils.fieldList(ent.doc_structure);

      fields.filter(field => (field.element === SELECT || field.element === FORM_TABLE) && field.data.options).map(field => {
        const options = Array.isArray(field.data.options) ? field.data.options : (field.data.options || "").split("\n")[0];
        if (options === this.__ENTITY__.name) {
          relatedEntities.push({
            is_single: ref.is_single,
            entity: ref.__NAME__,
            field: field.data.name,
          })
        }
      });
    }

    const rels = [];
    for (const r of relatedEntities) {
      if(r.entity === "Document History") continue;

      const docs = await loopar.db.getAll(r.entity, ["name"], {
        [r.field]: this.name
      }, { isSingle: r.is_single });

      rels.push(...docs.filter(doc => doc.name).map(doc => {
        return {
          entity: r.entity,
          name: doc.name,
        }
      }));
    }

    return rels
  }

  async #makeField({ field, fieldName = field.data.name, value = null } = {}) {
    const nameToGet = (name) => {
      return loopar.utils.Capitalize(name.replaceAll(/_./g, match => match.charAt(1).toUpperCase()))
    }

    const checkIfFieldExistLikeAttribute = Object.getOwnPropertyDescriptor(this, fieldName);

    if(checkIfFieldExistLikeAttribute) {
      loopar.throw(`
        The field name ${fieldName} is already used as attribute of the ${this.__ENTITY__.name} document
        please change the name of the field in the doc_structure of the ${this.__ENTITY__.name} Entity
        or rename your attribute in the ${this.__ENTITY__.name} class.
      `)
    }

    if (!this.#fields[fieldName]) {
      if (field.element === FORM_TABLE) {
        const val = loopar.utils.isJSON(value) ? JSON.parse(value) : value;

        this.#fields[fieldName] = new DynamicField(
          field,
          (Array.isArray(val) && val.length > 0) ? value : this.__DATA__[fieldName]
        );
      } else {
        this.#fields[fieldName] = new DynamicField(field, value || this.__DATA__[fieldName]);
      }

      Object.defineProperty(this, `get${nameToGet(fieldName)}`, {
        get: () => {
          return this.#fields[fieldName];
        }
      });

      if(field.element === FORM_TABLE) {
        Object.defineProperty(this, fieldName, {
          get: async () => {
            const field = this.#fields[fieldName];
            const currentValue = field.value;
            if((!currentValue || currentValue.length === 0) && !this.__IS_NEW__) {
              return await this.getChildRawValues(field.options);
            }
            return field.value;
          },
          set: (val) => {
            if (Array.isArray(val)) {
              this.#fields[fieldName].value = val;
            } else {
              const v = loopar.utils.isJSON(val) ? JSON.parse(val) : [];
              if (Array.isArray(v)) {
                this.#fields[fieldName].value = v;
              }
            }
          },
          configurable: false,
          enumerable: true 
        });
      }else{
        Object.defineProperty(this, fieldName, {
          get: () => {
            return this.#fields[fieldName].value;
          },
          set: (val) => {
            this.#fields[fieldName].value = val;
          },
          configurable: false,
          enumerable: true 
        });
      }
    }
  }

  getDocypeStructure() {
    return loopar.utils.JSONparse(this.__ENTITY__.doc_structure, []).filter(field => field.data.name !== ID);
  }

  /**
   * Define `id` and the audit columns (`__created_at__`, …) as getter/setter
   * pairs backed by __DATA__ — like #makeField minus the DynamicField wrapper.
   * Safe for non-auditable entities (getters resolve to undefined) and
   * idempotent (never clobbers an already-defined property).
   */
  #defineFrameworkOwnedProps() {
    for (const name of FRAMEWORK_OWNED_COLUMN_NAMES) {
      if (Object.getOwnPropertyDescriptor(this, name)) continue;
      Object.defineProperty(this, name, {
        get: () => this.__DATA__?.[name],
        set: (val) => {
          if (!this.__DATA__) this.__DATA__ = {};
          this.__DATA__[name] = val;
        },
        configurable: false,
        enumerable: true,
      });
    }
  }

  async #makeFields(fields = this.getDocypeStructure()) {
    const entityFields = this.__ENTITY__.__REF__.__FIELDS__;

    await Promise.all(fields.map(async (field) => {
      if ((fieldIsWritable(field) || field.element === FORM_TABLE) && entityFields.includes(field.data.name)) {
        if(field.element !== SLOT || field.data.writable)
          await this.#makeField({ field });
      }

      await this.#makeFields(field.elements || []);
    }));
  }

  nameIsNull() {
    return (!this.name || this.name === "undefined") || this.name.length === 0;
  }

  /** A new record whose name comes from the entity's naming series. */
  get #usesNamingSeries() {
    return this.__IS_NEW__ && !this.__ENTITY__.is_single && !!this.__ENTITY__.naming_series && this.nameIsNull();
  }

  setUniqueName() {
    if (this.#usesNamingSeries) return;
    if (this.nameIsNull() && (this.__IS_NEW__ || this.__ENTITY__.is_single) && this.getName?.hidden === 1) {
      this.name = loopar.utils.randomString(12);
    }
  }

  async __ID__() {
    // Trust the cached id when set. The DB fallback covers a just-inserted
    // doc (id not pushed back to `this`) and a stale ref cache that didn't
    // SELECT `id` — without it deleteChildRecords would bind `undefined`.
    if (this.id != null) return this.id;
    return await loopar.db.getValue(this.__ENTITY__.name, "id", this.__DOCUMENT_NAME__);
  }

  /** Child entities of this document (its form tables) that have a table. */
  async #childEntities() {
    const out = [];
    for (const entity of Object.keys(this.childValuesReq)) {
      if (entity !== this.name && await loopar.db.hasTable(entity)) out.push(entity);
    }
    return out;
  }

  /** Query of the rows of `entity` that belong to this document (`parentId`). */
  #childRows(entity, parentId) {
    return loopar.db.qx()(entity).where({ parent_id: parentId, parent_document: this.__ENTITY__.name });
  }

  async deleteChildRecords() {
    const parentId = await this.__ID__();
    if (parentId == null) return;
    for (const entity of await this.#childEntities()) {
      await this.#childRows(entity, parentId).delete();
    }
  }

  /**
   * Writes the child tables sent with this document. A table is replaced as a
   * whole, in the order received (that order is the rows' order), but each row
   * that already belonged to this document keeps its `name`: links to a row
   * survive its parent's saves. Only new rows get a new name. Tables not sent
   * (not an array) are left as they are.
   */
  async #writeChildren(args) {
    const parentId = await this.__ID__();
    const parentDocument = this.__ENTITY__.name;
    const cleanParentId = Number.isFinite(+parentId) ? parseInt(parentId, 10) : parentId;

    for (const entity of await this.#childEntities()) {
      const value = this.childValuesReq[entity];
      const rows = loopar.utils.isJSON(value) ? JSON.parse(value) : Array.isArray(value) ? value : null;
      if (!rows) continue;

      const kept = new Set((await this.#childRows(entity, parentId).select("name")).map(row => String(row.name)));
      await this.#childRows(entity, parentId).delete();

      const nextId = await loopar.db.nextId(entity);
      for (const [index, row] of rows.entries()) {
        row.id = nextId + index;
        row.name = row.name != null && kept.has(String(row.name)) ? row.name : loopar.utils.randomString(15);
        row.parent_document = parentDocument;
        row.parent_id = cleanParentId;

        const document = await loopar.newDocument(entity, row);
        await document.save(args.forceChildren ? { forceChildren: true } : undefined);
      }
    }
  }

  async save() {
    const args = arguments[0] || {};
    const validate = args.validate !== false;

    this.setUniqueName();
    // Workflow entities: the state only changes through a transition.
    await guardWorkflowState(this);
    // Computed fields: beforeSave sees them already computed, and they are
    // computed again after it, so whatever it changed is reflected and a
    // client-sent value never reaches the database.
    await this.#applyFormulas();
    this.beforeSave && await this.beforeSave();
    await this.#applyFormulas();
    // The series number is reserved only after validation passes, so a
    // rejected save doesn't burn a number.
    const seriesPending = this.#usesNamingSeries;
    if (validate) await this.validate({ skipName: seriesPending });
    // The record and its child rows are written together or not at all.
    await loopar.db.withTransaction(async () => {
      if (seriesPending) this.name = await nextSeriesName(this.__ENTITY__.name, this.__ENTITY__.naming_series);
      await this.#hashSecrets();

      if (this.__IS_NEW__ || this.__ENTITY__.is_single) {
        await loopar.db.insertRow(this.__ENTITY__.name, this.stringifyValues(true), this.__ENTITY__.is_single);
        this.__DOCUMENT_NAME__ = this.name;
      } else {
        const data = this.valuesToSetDataBase(true);

        if (Object.keys(data).length) {
          await loopar.db.updateRow(
            this.__ENTITY__.name,
            this.__DOCUMENT_NAME__,
            data,
            this.__ENTITY__.is_single
          );
        }
      }

      if (!loopar.installing || args.forceChildren) await this.#writeChildren(args);
    });

    const uploadedRefs = await this.saveFiles();
    if (uploadedRefs.length > 0) {
      await this.#patchUploadedFileRefs(uploadedRefs);
    }


    if (this.installerApp && !loopar.installing) {
      const app = await loopar.getDocument("App", this.installerApp, null, { ifNotFound: null });
      app && app.bump("patch");
    }

    this.afterSave && await this.afterSave();
  }

  /**
   * The app this record installs into (entity flagged `include_in_installer`
   * AND the record carries an `app`), or null. Single source of truth for
   * both bumping the app version on save and scoping uploaded files
   * (`getFileScopeApp`), so a record and its assets never drift apart.
   */
  get installerApp() {
    return (this.__ENTITY__?.include_in_installer === 1 && this.app)
      ? this.app
      : null;
  }

  /**
   * App scope for files saved through this document: null → tenant
   * `{site}/uploads`; installer records → `apps/{app}/uploads` so assets
   * travel with the app. `Entity` overrides it (design-time content resolved
   * from `module`). Async because subclasses may need a DB lookup.
   */
  async getFileScopeApp() {
    return this.installerApp;
  }

  /**
   * Persist files that arrived with the request — `__REQ_FILES__` (multipart
   * binaries) and `__REMOTE_FILES__` (URL imports from the picker's "Web"
   * origin). Both scoped by `getFileScopeApp()`; returns uniform refs so
   * `#patchUploadedFileRefs` can backfill fields that reference by name.
   */
  async saveFiles() {
    const app = await this.getFileScopeApp();
    const uploadedRefs = [];

    const files = this.__DATA__.__REQ_FILES__ || [];
    for (const file of files) {
      const ref = await this._processFile(file, app);
      if (ref) uploadedRefs.push(ref);
    }

    for (const remote of this.#remoteFilesFromData()) {
      const ref = await this._processRemoteFile(remote, app);
      if (ref) uploadedRefs.push(ref);
    }

    // Bare URLs assigned server-side → reference assets (rewrites its own fields).
    await this.#importUrlFileFields(app);

    return uploadedRefs;
  }

  /**
   * Normalize file-type fields holding a bare `http(s)://` string (assigned
   * server-side, e.g. an OAuth avatar) into the canonical `[{ name, src, … }]`
   * via a File Manager *reference* import. Runs after the row is written,
   * re-persists only converted fields, idempotent; on failure the raw URL
   * stays (display resolvers tolerate it).
   */
  async #importUrlFileFields(app) {
    const FILE_ELEMENTS = new Set([FILE_INPUT, IMAGE_INPUT, FILE_UPLOADER]);
    const isRawUrl = (v) => typeof v === 'string' && /^https?:\/\//i.test(v.trim());

    const fieldNames = [];
    const collect = (nodes = []) => {
      for (const node of nodes) {
        if (node?.data?.name && FILE_ELEMENTS.has(node.element)) {
          fieldNames.push(node.data.name);
        }
        collect(node.elements || []);
      }
    };
    collect(this.getDocypeStructure());

    const patches = {};
    for (const fieldName of fieldNames) {
      const value = this.__DATA__?.[fieldName] ?? this[fieldName];
      if (!isRawUrl(value)) continue;

      const url = value.trim();
      let ref = null;
      try {
        ref = await this._processRemoteFile({ url, mode: 'reference' }, app);
      } catch (err) {
        console.warn(
          `[core-document] URL import failed for ${this.__ENTITY__.name}.${fieldName}:`,
          err?.message
        );
      }
      if (!ref) continue;

      patches[fieldName] = JSON.stringify([{
        name: ref.name,
        src: ref.src,
        previewSrc: ref.previewSrc,
        type: ref.type,
        size: ref.size,
      }]);
      this.__DATA__[fieldName] = patches[fieldName];
      this[fieldName] = patches[fieldName];
    }

    if (Object.keys(patches).length > 0) {
      await loopar.db.updateRow(
        this.__ENTITY__.name,
        this.__DOCUMENT_NAME__,
        patches,
        this.__ENTITY__.is_single
      );
    }
  }

  /** Parse `__REMOTE_FILES__` (JSON of `{ name, url, mode }`, staged by base-form.jsx). */
  #remoteFilesFromData() {
    const raw = this.__DATA__.__REMOTE_FILES__;
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  /** Import one URL via File Manager `remoteImport` (mode reference/download). Returns the ref or null. */
  async _processRemoteFile(remote, app = null) {
    if (!remote || !remote.url) return null;

    const fileManager = await loopar.newDocument("File Manager");
    fileManager.remoteImport = {
      url: remote.url,
      name: remote.name,
      mode: remote.mode,
    };
    if (app) fileManager.app = app;
    await fileManager.save();

    try {
      const ref = JSON.parse(fileManager.file_ref || '[{}]')[0] || {};
      if (ref.src) {
        return {
          name: fileManager.name,
          src: ref.src,
          previewSrc: ref.previewSrc,
          type: ref.type || fileManager.type,
          size: ref.size || fileManager.size,
        };
      }
    } catch {}
    return null;
  }

  /** Upload one binary via File Manager (active driver). Returns the ref or null. `app` = scope. */
  async _processFile(file, app = null) {
    const fileManager = await loopar.newDocument("File Manager");
    fileManager.reqUploadFile = file;
    if (app) fileManager.app = app;
    await fileManager.save();

    try {
      const ref = JSON.parse(fileManager.file_ref || '[{}]')[0] || {};
      if (ref.src) {
        return {
          name: fileManager.name,
          src: ref.src,
          previewSrc: ref.previewSrc,
          type: ref.type || fileManager.type,
          size: ref.size || fileManager.size,
        };
      }
    } catch {}
    return null;
  }

  /**
   * The client strips `src` when serializing file refs (keeps `{ name, size,
   * type }` — see base-form.jsx#buildDesignerToSave), so after upload the
   * saved doc has dangling refs the renderer can't resolve for non-local
   * drivers. Walk every JSON string field on __DATA__, inject src/previewSrc
   * into refs matching an uploaded name, and re-persist. Only file-ref-shaped
   * objects (missing `src`) are touched.
   */
  async #patchUploadedFileRefs(uploadedRefs) {
    const byName = new Map(uploadedRefs.map(r => [r.name, r]));

    const isFileRefShape = (obj) =>
      obj && typeof obj === 'object' && !Array.isArray(obj)
      && typeof obj.name === 'string'
      && (obj.size !== undefined || obj.type !== undefined || obj.importPending === true)
      && !obj.src;

    let touched = false;

    const walk = (node) => {
      if (Array.isArray(node)) {
        for (const item of node) {
          if (isFileRefShape(item) && byName.has(item.name)) {
            const r = byName.get(item.name);
            item.src = r.src;
            item.previewSrc = r.previewSrc;
            
            if (item.importPending) delete item.importPending;
            touched = true;
          }
          walk(item);
        }
      } else if (node && typeof node === 'object') {
        for (const k of Object.keys(node)) {
          walk(node[k]);
        }
      }
    };

    const patches = {};
    for (const [key, value] of Object.entries(this.__DATA__ || {})) {
      if (typeof value !== 'string') continue;
      const trimmed = value.trimStart();
      if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) continue;

      let parsed;
      try { parsed = JSON.parse(value); } catch { continue; }

      touched = false;
      walk(parsed);

      if (touched) {
        patches[key] = JSON.stringify(parsed);
        this.__DATA__[key] = patches[key];
      }
    }

    if (Object.keys(patches).length > 0) {
      await loopar.db.updateRow(
        this.__ENTITY__.name,
        this.__DOCUMENT_NAME__,
        patches,
        this.__ENTITY__.is_single
      );
    }
  }

  fieldsName() {

  }

  async validate({ skipName = false } = {}) {
    const errors = Object.values(this.#fields)
      .filter(field => field.name !== ID && !(skipName && field.name === "name")).map(e => e.validate())
      .filter(e => !e.valid).map(e => e.message);

    const selectTypes = await this.validateLinkDocuments();
    !loopar.installing && errors.push(...selectTypes);

    errors.length > 0 && loopar.throw(errors.join('<br/>'));
  }

  async validateLinkDocuments() {
    const errors = [];
    for (const field of Object.values(this.#fields)) {
      if (field.element === SELECT && field.options && typeof field.options === 'string') {
        const value = field.formattedValue;
        const options = (field.options || "").split("\n");

        if (!value || value === "") continue;

        if (options.length > 1) {
          const keys = options.map(opt => {
            return opt.split(":")[0]
          });

          if (!keys.includes(value)) {
            errors.push(`The value ${value} for ${field.name} can only be one of the list of options`);
          }
        } else {
          const errForNotValidDocument = `The field ${field.name} does not have a valid document configured, please check the document metadata or contact an Administrator.`;

          if (options[0] === "") {
            errors.push(errForNotValidDocument);
          } else {
            const linkedRef = loopar.getRef(options[0], false);
            if (!linkedRef) {
              errors.push(errForNotValidDocument);
            } else {
              // Asked to the linked model: a virtual entity has no table to count.
              const linked = await loopar.newDocument(options[0]);
              if (!await linked.linkExists(value)) {
                errors.push(`The value ${value} for ${field.name} does not exist in ${field.options} Entity`);
              }
            }
          }
        }
      }
    }

    return errors;
  }

  async delete() {
    const { sofDelete, force, build = true } = arguments[0] || {};
    const connections = await this.getConnectedDocuments();

    let message = connections.map((e, index) => {
      return `<a href='/desk/${e.entity}/update?name=${e.name}'>${index+1}: <strong>${e.entity}</strong>.${e.name}</a>`;
    }).join("<br/>");
    
    message = `<h2>Is not possible to delete ${this.__ENTITY__.name}.${this.name} because it is connected to:</h2><br/> ${message}`;

    if (connections.length > 0 && !force) {
      loopar.throw({
        ...VALIDATION_ERROR,
        message: message
      });
      return;
    }

    await loopar.db.withTransaction(async () => {
      await this.deleteChildRecords();
      await loopar.db.deleteRow(this.__ENTITY__.name, this.__DOCUMENT_NAME__, sofDelete);
    });
    console.log(["Deleting", this.__ENTITY__.name, this.name]);

    await this.trigger('afterDelete', this);
  }

  async __meta__(withData = true) {
    const entity = this.__ENTITY__;
    const __DATA__ = this.__IS_NEW__ ? {} : await this.values();

    {
      const updateValue = async (structure) => {
        return Promise.all(structure.map(async (el) => {
          const data = el.data;
          const val = __DATA__[data.name];
      
          // value_descriptive needs saved data; child-table meta does not —
          // a new record still has to render its form_table columns.
          if (!this.__IS_NEW__ && el.element === SELECT) {
            const options = (data.options || "").split("\n");
    
            if (options.length > 1) {
              const [value, label] = (options.find(opt => (opt || "").split(":")[0] === val) || "").split(":");
              el.data.value_descriptive = label || value;
            } else {
              // const db = loopar.db;
              // if (await db.hasEntity(null, data.options) && await db.count(data.options, data.value) > 0) {
              //   const doc = await loopar.getDocument(data.options, data.value);
              //   el.data.value_descriptive = await doc.getValueDescriptive();
              // }
            }
          }
          if(el.element === FORM_TABLE) {
            const ref = loopar.getRef(data.options);
            if (ref) el.__META__ = {
              Entity: {
                doc_structure: await loopar.db.getValue(ref.__ENTITY__, "doc_structure", ref.__NAME__),
              }
            }
          }
      
          el.elements = await updateValue(el.elements || []);
          return el;
        }));
      };
  
      const updateDocStructure = async () => {
        entity.doc_structure = JSON.stringify(await updateValue(
          loopar.utils.JSONparse(entity.doc_structure, [])
        ));
      };

      await updateDocStructure();
    }

    const __ENTITY__ = entity;
    delete __ENTITY__.__REF__;

    // History flags come from the registry ref so forms can auto-mount the timeline.
    const __REF__ = loopar.getRef(__ENTITY__.name) || {};
    const workflow = __ENTITY__.is_single ? null : await workflowFor(__ENTITY__.name);
    if (workflow) {
      // The state changes through transitions only: show its field read-only.
      const pin = (nodes = []) => nodes.map(el => ({
        ...el,
        ...(el.data?.name === workflow.field ? { data: { ...el.data, readonly: 1 } } : {}),
        ...(el.elements ? { elements: pin(el.elements) } : {}),
      }));
      __ENTITY__.doc_structure = JSON.stringify(pin(loopar.utils.JSONparse(__ENTITY__.doc_structure, [])));
    }

    return {
      name: this.__DOCUMENT_NAME__,
      isNew: this.__IS_NEW__,
      Entity: {
        id: __ENTITY__.id,
        name: __ENTITY__.name,
        module: __ENTITY__.module,
        title_fields: __ENTITY__.title_fields,
        doc_structure: __ENTITY__.doc_structure,
        ...(this.is_builder ? {is_builder: true} : {}),
        is_single: __ENTITY__.is_single,
        enable_history: loopar.utils.trueToBinary(__REF__.enable_history),
        enable_comments: loopar.utils.trueToBinary(__REF__.enable_comments),
        require_login_to_comment: loopar.utils.trueToBinary(__REF__.require_login_to_comment)
      },
      ...(withData || 1==1 ? { data: await this.rawValues() } : {}),
      ...(workflow ? { workflow: await describeWorkflow(this, workflow) } : {}),
      spacing: this.__SPACING__
    }
  }

  async values(raw=false) {
    const value = async (field) => {
      if (field.element === DESIGNER) {
        return field.value ? JSON.stringify(await parseDocStructure(field.value, false, this.name, {}, this.__APP__)) : "[]";
      } else if (field.element === FORM_TABLE || field.element == REVIEW) {
        return await this.getChildRawValues(field.options);
      }
      
      /*else if (field.element === SELECT) {
        if (field.options && typeof field.options === 'string') {
          const options = (field.options || "").split("\n");

          if (options.length === 1) {
            const value = await loopar.db.getValue(field.options, "name", field.value);
            return JSON.stringify({ option: field.value, title: value });
          }
        }

        return JSON.stringify({ option: field.value, value: field.value });
      }*/
      else if (field.element === PASSWORD) {
        return raw ? field.value : (field.value && field.value.length > 0 ? this.protectedPassword : "");
      } else if(field.element === MARKDOWN){
        return field.value;
      } else {
        return field.stringifyValue();
      }
    }

    return Object.values(this.#fields).reduce(async (acc, cur) => {
      return { ...await acc, [cur.name]: await value(cur) }
    }, {});
  }

  /**
   * Hash-mode password fields are hashed here (async) right before persisting;
   * encrypt-mode ones are encrypted synchronously in DynamicField.stringifyValue.
   * Masked (untouched), empty and already-hashed values are left alone, so a
   * stored hash loaded back into the document is never hashed twice.
   */
  async #hashSecrets() {
    for (const field of Object.values(this.#fields)) {
      if (field.element !== PASSWORD || field.secretMode !== 'hash') continue;
      const value = field.value;
      if (!value || value === this.protectedPassword || isHashedSecret(value)) continue;
      field.value = await loopar.hash(String(value));
    }
  }

  async rawValues() {
    const value = async (field) => {
      if (field.element === DESIGNER) {
        const fieldValue = loopar.utils.JSONparse(field.value, field.value)
        // The form view renders from rawValues (not parseDocStructure), so
        // cookie indexes must be injected here or SSR/hydration mismatch.
        return field.value ? JSON.stringify(
          injectCookieIndexes(fieldValue.filter(field => (field.data || []).name !== ID))
        ) : "[]";
      } else if (field.element === FORM_TABLE) {
        return await this.getChildRawValues(field.options);
      } else if (field.element === PASSWORD) {
        return field.value && field.value.length > 0 ? this.protectedPassword : "";
      } else {
        return field.stringifyValue();
      }
    }
    return Object.values(this.#fields).reduce(async (acc, cur) => {
      return { ...await acc, [cur.name]: await value(cur) }
    }, {});
  }

  /**
   * Recomputes the formula fields (`data.formula`). Child rows sent with the
   * request are recomputed with their entity's formulas first, so parent
   * aggregates (`sum(lines.line_total)`) read the final row values; tables
   * not sent read their stored rows.
   */
  async #applyFormulas() {
    const ref = this.__ENTITY__.__REF__ || loopar.getRef(this.__ENTITY__.name) || {};
    const formulas = ref.__FORMULAS__ || {};
    const tables = {};

    for (const name of ref.__FORM_TABLE_FIELDS__ || []) {
      const field = this.#fields[name];
      if (!field) continue;

      const sent = field.value;
      const hasRows = Array.isArray(sent) || (typeof sent === "string" && sent.trim().startsWith("["));
      let rows = hasRows ? tableRows(sent) : null;

      const rowFormulas = loopar.getRef(field.options)?.__FORMULAS__ || {};
      if (rows && Object.keys(rowFormulas).length) {
        rows = rows.map(row => ({ ...row, ...computeFormulas(rowFormulas, row) }));
        field.value = rows;
      }

      tables[name] = rows ?? (this.__IS_NEW__ ? [] : await this.getChildRawValues(field.options));
    }

    if (!Object.keys(formulas).length) return;

    const scope = { ...tables };
    for (const field of Object.values(this.#fields)) {
      if (field.element !== FORM_TABLE) scope[field.name] = field.value;
    }

    for (const [name, value] of Object.entries(computeFormulas(formulas, scope))) {
      if (this.#fields[name]) this.#fields[name].value = value;
    }
  }

  /**
   * Every row of a child table, with every column, in insertion order. Server
   * code reads, edits and saves these rows back, so nothing may be left out
   * (no list columns, pages or owner scope: a child row belongs to its parent).
   */
  async getChildRawValues(field) {
    return await loopar.db.qx()(field)
      .select("*")
      .where({ parent_id: await this.__ID__(), parent_document: this.__ENTITY__.name })
      .orderBy("id");
  }

  stringifyValues(toSave = false) {
    return Object.values(this.#fields)
      .filter(field => field.element !== FORM_TABLE)
      .filter(field => (field.element === PASSWORD ? field.value != this.protectedPassword : true))
      .reduce((acc, cur) => ({ ...acc, [cur.name]: cur.stringifyValue(toSave) }), {});
  }

  valuesToSetDataBase(toSave = false) {
    return Object.values(this.#fields).filter(field => {
      if ((this.__IS_NEW__ && field.set_only_time) || field.element === FORM_TABLE) return false;

      if (field.element === PASSWORD) {
        return field.value !== this.protectedPassword;
      }

      return true;
    }).reduce((acc, cur) => ({ ...acc, [cur.name]: cur.stringifyValue(toSave) }), {});
  }

  get childValuesReq() {
    return Object.values(this.#fields)
      .filter(field => field.name !== ID && field.element === FORM_TABLE)
      .reduce((acc, cur) => ({ ...acc, [cur.options]: cur.value }), {});
  }

  get formattedValues() {
    return Object.values(this.#fields)
      //.filter(field => field.name !== ID)
      .reduce((acc, cur) => ({ ...acc, [cur.name]: cur.formattedValue }), {});
  }
}