import { BaseDocument, fileManage, loopar, Helpers, pruneDocStructure, TYPES, namingSeriesError } from "loopar";
import { pluralize } from "inflection";

export default class Entity extends BaseDocument {
  get is_builder() {return true};

  constructor(props) {
    super(props);
  }

  /**
   * Scope files saved through an Entity to its owning app (overrides
   * `CoreDocument.getFileScopeApp()` which returns null / site).
   *
   * Anything saved through an `Entity` subclass (page builders,
   * designed forms, custom entities…) is design-time content that
   * belongs to an app and must travel with its code/installer.
   * `CoreDocument`'s default (site-scoped) is for runtime attachments.
   *
   * Resolved fresh from `module` via `targetApp()` so a just-edited
   * module field routes the asset to the right app.
   */
  async getFileScopeApp() {
    return await this.targetApp();
  }

  entityIsSingle() {
    return (["Page", "Form", "Report", "View", "Controller", "Print Format", "Desk Page"].includes(this.getEntityType()) || this.is_single) ? 1 : 0;
  }

  validateEntityName() {
    const entityName = this.name;

    if (entityName.length < 3) {
      loopar.throw('Entity name must be at least 3 characters long.');
    }

    if (entityName.length > 64) {
      loopar.throw('Entity name must be at most 64 characters long.');
    }

    if (!/^[a-zA-Z0-9 ]+$/.test(entityName)) {
      loopar.throw('Entity name must contain only letters, numbers and spaces.');
    }

    if (/^[0-9]/.test(entityName)) {
      loopar.throw('Entity name must not start with a number.');
    }

    if (!/^[A-Z]/.test(entityName)) {
      loopar.throw('Entity name must start with an uppercase letter (PascalCase convention).');
    }

    const words = entityName.split(' ');
    for (const word of words) {
      if (!/^[A-Z][a-zA-Z0-9]*$/.test(word)) {
        loopar.throw('Each word in Entity name must start with uppercase letter.');
      }
    }
  }

  validateNamingSeries() {
    if (!this.naming_series) return;
    if (this.entityIsSingle()) loopar.throw("A single entity has no records to number: remove its naming series.");
    const error = namingSeriesError(this.naming_series);
    error && loopar.throw(error);
  }

  validateUniqueEntityName() {
    if (!loopar.installing && this.__IS_NEW__) {
      const ref = loopar.getRef(this.name, false);
      
      if (ref) {
        loopar.throw(
          `An entity with a similar name already exists: "${ref.__NAME__}" ` +
          `(${ref.__ENTITY__} in app "${ref.__APP__}"). ` +
          `Names like "${this.name}", "${ref.__NAME__}", and similar variations are considered duplicates.`
        );
      }
    }
  }

  async validateAppName() {
    const appName = await this.targetApp();
    if (!appName) {
      loopar.throw(`Module ${this.module} has not associated app name`);
    }
  }

  async save() {
    this.is_single = this.entityIsSingle();
    this.is_static = 0;

    const args = arguments[0] || {};
    const validate = args.validate !== false;

    await this.normalizeFields(this.doc_structure);

    if (validate) {
      this.validateFields();
      this.validateEntityName();
      this.validateNamingSeries();
      await this.validateAppName();
      this.validateUniqueEntityName();

      if (!loopar.installing) {
        await this.validateStructuralFlags();
        await this.validateAppVersion();
        await this.validateLinkedDocument(SELECT);
        await this.validateLinkedDocument(FORM_TABLE);
      }
    }

    const write = async () => {
      if (this.isDBEntity()) {
        await loopar.db.makeTable(this.name, this.doc_structure, {
          entityMeta: {
            name: this.name,
            is_static: this.is_static,
            is_child: this.is_child,
            is_single: this.is_single,
            is_audited: this.is_audited,
          },
        });
      }

      args.save != false && await super.save(arguments[0] || {});
    };

    if (!loopar.installing) {
      // The table change and the entity record, together or not at all.
      await loopar.db.withTransaction(write);
      await this.__build__();
    } else {
      await write();
      await this.makeViews();
    }
  }

  async initialize() {
    this.is_single = this.entityIsSingle();
    this.is_static = 0;
   
    await this.normalizeFields(this.doc_structure);
    await loopar.db.makeTable("Entity", this.doc_structure, {
      entityMeta: { name: "Entity", is_static: 0, is_child: 0, is_single: 0 },
    });
  }

  clientFieldsList(fields = this.doc_structure) {
    return loopar.utils.fieldList(fields);
  }

  writableFieldsList({ includeFormTable = false } = {}) {
    return this.clientFieldsList().filter(field => fieldIsWritable(field) && (includeFormTable || field.element !== FORM_TABLE));
  }

  getSpecialMetaFields() {
    return {
      namedContainer: {
        element: ROW,
        data: {
          name: 'name_and_status_container',
        },
        elements: []
      },
      elementsNamed: [
        {
          element: INPUT,
          data: {
            name: 'name',
            label: 'Name',
            required: 1,
            type: TYPES.string,
            in_list_view: 1,
            set_only_time: 1,
            unique: 1,
            searchable: 1
          }
        }
      ]
    };
  }

  insertField(field, targetField, position = 'after') {
    const fields = this.doc_structure;

    const insertField = (fields, field, targetField, position = 'after') => {
      for (let i = 0; i < fields.length; i++) {
        if (fields[i].data.name === targetField) {
          if (position === 'after') {
            fields.splice(i + 1, 0, field);
          } else if (position === 'before') {
            fields.splice(i, 0, field);
          }
          return;
        } else if (fields[i].elements && fields[i].elements.length > 0) {
          insertField(fields[i].elements, field, targetField, position);
        }
      }
    }

    insertField(fields, field, targetField, position);
  }

  getEntityType(){
    return this.__ENTITY__.build || this.__ENTITY__.name || "Entity";
  }

  isDBEntity(){
    // "Contact Form": record-holding entities generated by the Contact Form
    // Builder — they need a real table (makeTable + meta-field injection)
    // exactly like plain Entities. Omitting a build type here means its
    // documents get a ref + json but a column-less shell table, which bricks
    // the boot field test ("no such column").
    return ["Entity", "Builder", "Contact Form"].includes(this.getEntityType()) && !this.entityIsSingle() && this.is_virtual != 1;
  }

  /**
   * Walk doc_structure recursively and call `visitor(field)` on every node.
   * Mutates `field` in place when the visitor mutates. Returns nothing.
   */
  #walkDocStructure(visitor, fields = this.doc_structure) {
    if (!Array.isArray(fields)) return;
    for (const field of fields) {
      visitor(field);
      if (Array.isArray(field?.elements) && field.elements.length > 0) {
        this.#walkDocStructure(visitor, field.elements);
      }
    }
  }

  /**
   * Locate a field by `data.name` anywhere in the doc_structure tree.
   * Returns the first match or undefined.
   */
  #getField(fieldName) {
    let found;
    this.#walkDocStructure(f => { if (!found && f?.data?.name === fieldName) found = f; });
    return found;
  }

  #updateOrInsertField({ field, position = null, target = null }) {
    const fields = this.doc_structure || [];
    let foundField  = false;
    let targetFound = fields;

    const searchAndInsert = (items) => {
      for (const f of items) {
        if (target && f?.data?.name === target) {
          targetFound = f.elements ?? null;
        }
        if (field.data.name === f?.data?.name) {
          foundField = true;
          Object.assign(f.data, field.data);
        } else if (Array.isArray(f?.elements) && f.elements.length > 0) {
          searchAndInsert(f.elements);
        }
      }
    };
    searchAndInsert(fields);

    if (!foundField) {
      if (position === 'before') targetFound.unshift(field);
      else                       targetFound.push(field);
    }
    this.doc_structure = fields;
  }

  #removeField(fieldName) {
    const removeFrom = (fields) => {
      for (let i = fields.length - 1; i >= 0; i--) {
        const f = fields[i];
        if (f?.data?.name === fieldName) {
          fields.splice(i, 1);
        } else if (Array.isArray(f?.elements) && f.elements.length > 0) {
          removeFrom(f.elements);
        }
      }
    };
    removeFrom(this.doc_structure);
  }

  async #normalizeFieldData(field) {
    const NULL_VALUES = [null, undefined, "", "null", "undefined", 0, "0"];
    const updated = {};

    for (const [key, value] of Object.entries(field.data || {})) {
      if (key === "name" && NULL_VALUES.includes(value)) {
        updated[key] = Helpers.randomString(12);
      } else {
        updated[key] = value;
      }

      if (this.__IS_NEW__ && key === "required" && field.data.required) {
        updated[key] = 1;
      }

      if (
        (key === "background_color" || key === "color_overlay") &&
        JSON.stringify(value) === '{"color":"#000000","alpha":0.5}'
      ) {
        delete updated[key];
      }
    }
    return updated;
  }

  /** Recursively apply #normalizeFieldData to every field in the subtree. */
  async #normalizeElements(elements = []) {
    for (const field of elements) {
      field.data = await this.#normalizeFieldData(field);
      if (Array.isArray(field?.elements) && field.elements.length > 0) {
        await this.#normalizeElements(field.elements);
      }
    }
    this.doc_structure = elements;
  }

  /**
   * Inject framework-required meta fields into the doc_structure of a
   * DB-backed entity:
   *   - `name` + `id` inside a synthetic row container (the "named
   *     container") so the form layout has somewhere to mount them.
   *   - `parent_document` + `parent_id` for child entities (FORM_TABLE
   *     rows, where the parent reference is part of the row contract).
   *
   * Skipped during install (the snapshot already contains what it needs)
   * and for non-DB entities (singles, builders without storage).
   */
  #injectMetaFields() {
    if (!this.isDBEntity()) return;

    const special = this.getSpecialMetaFields();
    const containerName = special.namedContainer.data.name;

    this.#updateOrInsertField({ field: special.namedContainer, position: 'before' });
    for (const field of special.elementsNamed) {
      this.#updateOrInsertField({ field, position: 'after', target: containerName });
    }

    const container = this.#getField(containerName);
    if (container && (!container.elements || container.elements.length === 0)) {
      this.#removeField(containerName);
    }

    if (this.is_child) {
      this.#updateOrInsertField({
        field: {
          element: INPUT,
          data: { name: "parent_document", label: "Parent Entity", type: TYPES.string, hidden: 1 }
        },
        position: 'before',
      });
      this.#updateOrInsertField({
        field: {
          element: INPUT,
          data: { name: "parent_id", label: "Parent ID", type: TYPES.integer, hidden: 1 }
        },
        position: 'before',
      });
    }
  }

  async normalizeFields() {
    this.#injectMetaFields();
    await this.#normalizeElements(this.doc_structure);
    this.doc_structure = pruneDocStructure(this.doc_structure);
  }

  async delete() {
    const ref = loopar.getRef(this.name);

    if (ref && ref.__APP__ === 'loopar' && ref.__TYPE__ == "Entity") {
      loopar.throw(`You can not delete Entity:${this.name}, it is a core Entity.`);
      return;
    }

    await super.delete(...arguments);

    if (!loopar.installing) {
      await this.makeJSON();
    }
  }

  validateFieldName(name) {
    if (!name) return;
    const errMessage = `Field name <strong>"${name}"</strong> is not valid. <br/>`;
    
    if (name.length < 2 && name !== 'id') {
      loopar.throw(`${errMessage}Field name must be at least 2 characters long.`);
    }
  
    if (name.length > 64) {
      loopar.throw(`${errMessage}Field name must be at most 64 characters long.`);
    }
  
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
      loopar.throw(`${errMessage}Field name must start with a letter or underscore, and contain only letters, numbers and underscores.`);
    }
  }

  validateFields() {
    const fields = this.clientFieldsList();

    for (const field of fields) {
      if(!fieldIsWritable(field)) continue;
      this.validateFieldName(field.data.name);
    }

    const duplicates = fields.map(field => field.data.name).filter((value, index, self) => value && self.indexOf(value) !== index);

    if (duplicates.length) {
      loopar.throw(`Duplicate field names:<br/> ${duplicates.join(', ')}`);
    }
  }

  /**
   * is_child, is_single and is_virtual decide where an entity's data lives
   * (child rows under a parent, Document Single Values, or no table at all).
   * They can only be combined coherently, and only changed while the data
   * that would be stranded by the change does not exist.
   */
  async validateStructuralFlags() {
    const flag = (v) => (v === 1 || v === true || v === "1") ? 1 : 0;
    const next = {
      is_child: flag(this.is_child),
      is_single: flag(this.entityIsSingle()),
      is_virtual: flag(this.is_virtual),
    };

    if (next.is_child && next.is_single) loopar.throw("A child entity can not be single.");
    if (next.is_child && next.is_virtual) loopar.throw("A child entity can not be virtual: its rows are stored in its own table.");

    if (this.__IS_NEW__) return;

    // Refs are built from the saved records: they hold the current flags.
    const ref = loopar.getRef(this.name, false);
    if (!ref) return;

    const prev = {
      is_child: flag(ref.is_child),
      is_single: flag(ref.is_single),
      is_virtual: flag(ref.is_virtual),
    };

    const tableHasRows = async () => {
      if (!(await loopar.db.hasTable(this.name))) return false;
      return !!(await loopar.db.qx()(this.name).first("id"));
    };

    const changed = (key) => prev[key] !== next[key];
    const errors = [];

    if (changed("is_child")) {
      if (next.is_child) {
        if (!prev.is_single && !prev.is_virtual && await tableHasRows()) {
          errors.push(`${this.name} already has records without a parent document: it can only become a child entity while it is empty.`);
        }
      } else {
        const parents = await this.formTableParents();
        if (parents.length) {
          errors.push(`${this.name} is used as a child table in ${parents.join(", ")}: remove it from there before making it a regular entity.`);
        }
      }
    }

    if (changed("is_single")) {
      if (next.is_single) {
        if (!prev.is_virtual && await tableHasRows()) {
          errors.push(`${this.name} already has records: it can only become single while its table is empty.`);
        }
      } else if (await loopar.db.count("Document Single Values", { document: this.name }) > 0) {
        errors.push(`${this.name} already has saved values: it can only stop being single while it has none.`);
      }
    }

    if (changed("is_virtual") && next.is_virtual && !prev.is_single && await tableHasRows()) {
      errors.push(`${this.name} already has records: it can only become virtual while its table is empty.`);
    }

    errors.length && loopar.throw(errors.join("<br/>"));
  }

  /** Entities with a form_table field whose options point to this entity, as "Entity (field)". */
  async formTableParents() {
    const parents = [];
    const target = this.name.toLowerCase();

    // All refs, not only installed apps: a parent may ship in an app that is
    // not installed on this tenant yet (getValue then simply finds nothing).
    for (const ref of Object.values(loopar.getRefs(null, true) ?? {})) {
      if (!ref.__FORM_TABLE_FIELDS__?.length || ref.__NAME__ === this.name) continue;

      const structure = await loopar.db.getValue(ref.__ENTITY__, "doc_structure", ref.__NAME__, { ifNotFound: null });
      const fields = loopar.utils.fieldList(loopar.utils.JSONparse(structure, []));

      for (const field of fields) {
        if (field.element !== FORM_TABLE) continue;
        const options = String(field.data?.options || "").split("\n")[0].split(":")[0].trim();
        if (options.toLowerCase() === target) parents.push(`${ref.__NAME__} (${field.data.name})`);
      }
    }

    return parents;
  }

  async validateLinkedDocument(type) {
    const errors = [];
    const fields = this.clientFieldsList();
    for (const field of fields) {
      if (field.element === type && field.data.options && typeof field.data.options === "string") {
        const options = (field.data.options || "").split("\n");

        if (options.length === 1 && options[0] !== "") {
          const name = options[0].split(":")[0];
          const ref = loopar.getRef(name);
          if(!ref) continue;

          if (await loopar.db.count(ref.__ENTITY__, name) === 0) {
            errors.push(`${ref.__ENTITY__} ${name} is not a valid Entity for ${field.data.name}, please check the options.`);
          } else if (type === FORM_TABLE) {
            const isSingle = await loopar.db.getValue(ref.__ENTITY__, "is_single", name);
            if (isSingle) {
              errors.push(`Entity ${name} is a single Entity, please use a Entity with multiple records.`);
            }

            const isChild = await loopar.db.getValue(ref.__ENTITY__, "is_child", name);

            if (isChild !== 1) {
              errors.push(`${ref.__ENTITY__} ${name} is not a child Entity, please use a child Entity.`);
            }
          }
        }
      }
    }

    if (errors.length > 0) {
      loopar.throw(errors.join("<br/>"));
    }
  }

  async targetApp() {
    // During the first install of a tenant the Module table is being created
    // and is still empty, so this lookup returns null and downstream callers
    // build paths like `apps/modules/<module>` (missing the app segment) —
    // ENOENT on scandir and the install aborts. Fall back to the app
    // currently being installed so the path stays well-formed. After
    // bootstrap the DB row exists and the fallback is never reached.
    const fromDb = await loopar.db.getValue(
      "Module", "app_name", this.module, { ifNotFound: null }
    );
    return fromDb || loopar.installingApp || null;
  }

  async validateAppVersion() {
    const appName = await this.targetApp();
    if (!appName) return;

    const installerData = fileManage.getConfigFile(
      'installer',
      loopar.makePath('apps', appName),
      null
    );
    const physical = installerData?.App?.version;
    if (!physical) return;

    const installedApp = await loopar.getApp(appName);
    const installed = installedApp?.version;
    if (!installed) return;

    if (this.#compareVersion(physical, installed) > 0) {
      loopar.throw(
        `Cannot modify entities of "${appName}": ` +
        `physical version (${physical}) is ahead of installed (${installed}). ` +
        `Run <a href="/desk/App Manager/view">Update</a> first to sync the database.`
      );
    }
  }

  #compareVersion(a, b) {
    const pa = (a || '0.0.0').split('.').map(n => parseInt(n, 10) || 0);
    const pb = (b || '0.0.0').split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < 3; i++) {
      if (pa[i] !== pb[i]) return pa[i] - pb[i];
    }
    return 0;
  }

  async modulePath() {
    const type = this.getEntityType();
    console.log(["Traget App", await this.targetApp()]);
    return loopar.makePath("apps", await this.targetApp(), "modules", this.module, pluralize(type));
  }

  async documentPath() {
    return loopar.makePath(await this.modulePath(), this.name);
  }

  async clientPath() {
    return loopar.makePath(await this.documentPath(), 'client');
  }

  async __build__() {
    await this.makeDocumentStructure();
    await this.makeViews();
    await this.makeJSON();
    !loopar.installing && await loopar.build();
  }

  async makeDocumentStructure() {
    await fileManage.makeFolder(await this.documentPath(), 'client');
  }

  async __meta__(withData = true) {
    const meta = await super.__meta__(withData);
    const spacing = loopar.__installed__ ? await loopar.db.getDoc("App", await this.targetApp(), ["gap", "col_padding"]) : {};

    return {
      ...meta,
      spacing,
    }
  }

  async makeViews() {
    const documentPath = await this.documentPath();

    const type = this.getEntityType();

    /*Entity Model*/
    // Builder-specific bases: documents generated by specialized builders
    // (e.g. Contact Form Builder) inherit their security/validation layer
    // from a dedicated base class instead of the plain BaseDocument.
    const extendDocument = type === "Contact Form" ? "ContactFormBase" : "BaseDocument";

    await fileManage.makeClass(documentPath, this.name, {
      IMPORTS: {
        [extendDocument]: 'loopar',
      },
      EXTENDS: extendDocument
    });
    /*Entity Model*/

    // Child entities have no controller: their rows are only reachable through
    // the parent document (the router refuses them). Turning an existing
    // entity into a child removes its controller.
    if (this.is_child) {
      await fileManage.deleteFile(documentPath, `${this.name}Controller`);
      return;
    }

    const extendController = type === "Contact Form"
      ? "BaseContactFormController"
      : type === "Print Format"
        ? "PrintFormatController"
        : type === "Desk Page"
          ? "DeskPageController"
          : (["Single", "View", "Page", "Form", "Report"].includes(type) ? type : "Base") + "Controller";

    await fileManage.makeClass(documentPath, `${this.name}Controller`, {
      IMPORTS: {
        [extendController]: 'loopar',
      },
      EXTENDS: extendController
    });
    /*Entity Controller*/

    // Client views are NOT generated anymore: the document entry renders its
    // default when no `client/<entity>-<kind>.jsx` exists (see
    // packages/loopar/src/loader.jsx). An app adds that file by hand only
    // when the view needs custom logic.
  }

  async makeJSON() {
    const meta = await this.__meta__();

    const { __created_at__, __updated_at__, __deleted_at__, __document_status__, __created_by__, ...payload } = meta.data;
    if (__deleted_at__) {
      payload.__deleted_at__ = __deleted_at__;
    }

    await fileManage.setConfigFile(
      this.name,
      { ...payload, __ENTITY__: meta.Entity.name },
      await this.documentPath()
    );

    const app = await loopar.getDocument("App", await this.targetApp());
    await app.bump("patch");
  }

  async getOrphanColumns(){
    if(this.__IS_NEW__) return []

    return await loopar.db.getOrphanColumns(this.name, {});
  }
}

export {
  Entity
}