'use strict'

import CoreDocument from './core-document.js';
import { loopar } from '../loopar.js';
import { Op } from 'db-env';
import { CREATED_BY_COLUMN } from '../global/audit.js';
import { requestOwnerFilter } from '../auth/record-scope.js';

/** The entity a select links to, or null for inline options. */
function linkedEntity(options) {
  const entity = typeof options === "string" ? options.trim() : "";
  if (!entity || entity.includes("\n")) return null;
  return loopar.getRef(entity, false) ? entity : null;
}

function combineSConditions(...conditions) {
  const validConditions = conditions.filter(cond => {
    if (!cond || typeof cond !== 'object' || Array.isArray(cond)) {
      return false;
    }
    
    const hasNormalKeys = Object.keys(cond).length > 0;
    const hasSymbols = Object.getOwnPropertySymbols(cond).length > 0;
    
    return hasNormalKeys || hasSymbols;
  });
  
  if (validConditions.length === 0) return {};
  if (validConditions.length === 1) return validConditions[0];
  
  return { [Op.and]: validConditions };
}


export default class BaseDocument extends CoreDocument {
  validateReservedFieldName(fieldName){
    const restricrtedClass = [BaseDocument, CoreDocument]

    for(const C of restricrtedClass){
      const exist = Object.prototype.hasOwnProperty.call(this, fieldName);

      if(exist){
        console.log([fieldName, exist])
      }
    }
  }

  validateFieldNameLikeMethod(fieldName){
    const checkIfFieldExistLikeAttribute = Object.getOwnPropertyDescriptor(this, fieldName);
    if (checkIfFieldExistLikeAttribute) {
      loopar.throw(`
        The field name ${fieldName} is already used as attribute of the ${this.__ENTITY__.name} document
        please change the name of the field in the doc_structure of the ${this.__ENTITY__.name} Entity,
        or rename the attribute in the ${this.__ENTITY__.name} class.
      `);
    }
  }

  getFieldProperties(field_name) {
    const fields = Object.values(this.fields)
      .filter(k => k.name !== "__ENTITY__" && k.in_list_view).map(k => k[field_name]);

    return fields.length === 0 ? ['name'] : fields;
  }

  getFieldListNames() {
    const fields = this.getFieldProperties('name');

    return fields.length === 0 ? ['name'] : fields;
  }

  getFieldListLabels() {
    const labels = this.getFieldProperties('label');

    return labels.length === 0 ? ['Name'] : labels;
  }

  buildCondition(q = null){

    if (q === null) return {};

    Object.entries(q).forEach(([field, value]) => {
      if (!this.fields[field] || value === '') delete q[field];
    });

    const conditions = [];

    Object.entries(q).forEach(([key, value]) => {
      const field = this.fields[key];
      
      if (!field) return;

      if (value && value.toString().length > 0) {
        const isSelectType = [SELECT, SWITCH, CHECKBOX].includes(field.element);
        
        if ([SWITCH, CHECKBOX].includes(field.element)) {
          if ([1, '1'].includes(value)) {
            conditions.push({ [key]: 1 });
          }
        } else if (isSelectType) {
          conditions.push({ [key]: value });
        } else {
          conditions.push({ [key]: { [Op.like]: `%${value}%` } });
        }
      }
    });

    if (conditions.length === 0) return {};
    if (conditions.length === 1) return conditions[0];

    return { [Op.and]: conditions };
  }

  async #ownerColumn() {
    if (!this.__ENTITY__.__REF__?.__FIELDS__?.includes(CREATED_BY_COLUMN)) return [];
    try {
      const cols = await loopar.db.getTableColumns(this.__ENTITY__.name);
      return cols?.has(CREATED_BY_COLUMN) ? [CREATED_BY_COLUMN] : [];
    } catch {
      return [];
    }
  }

  async getList({ fields = null, filters = {}, q = null, rowsOnly = false, unscoped = false } = {}) {
    if (this.__ENTITY__.is_single) {
      return loopar.throw({
        code: 404,
        message: "This document is single, you can't get list"
      });
    }

    const pagination = {
      page: loopar.getPage(this.__ENTITY__.name),
      pageSize: 10,
      totalPages: 4,
      totalRecords: 1,
      sortBy: "id",
      sortOrder: "asc",
      __ENTITY__: this.__ENTITY__.name
    };

    const listFields = fields || this.getFieldListNames();
    /*if (this.__ENTITY__.name === 'Document' && currentController.document !== "Document") {
       listFields.push('is_single');
    }*/

    if (this.__ENTITY__.name === 'Entity') {
      listFields.push('is_single');
    }

    // Scope 'own' (auth/record-scope.js): narrows rows AND the count so
    // pagination matches. Only when this entity is the one the request targets.
    const scoped = unscoped ? null : await requestOwnerFilter(this.__ENTITY__.name);
    const condition = combineSConditions(this.buildCondition(q), filters, scoped);
    
    pagination.totalRecords = await this.records(condition);
    pagination.totalPages = Math.ceil(pagination.totalRecords / pagination.pageSize);
    const selfPagination = JSON.parse(JSON.stringify(pagination));
    loopar.db.pagination = pagination;

    // `__created_by__` rides along (not a visible column) so the client can
    // decide per row whether an 'own'-scoped action applies (AuthContext.canOn).
    // Only when the table has it: child/static entities are not auditable and
    // an app not yet updated lacks the column.
    const rows = await loopar.db.getList(this.__ENTITY__.name, [...listFields, "id", ...(await this.#ownerColumn())], condition);

    if (rows.length === 0 && pagination.page > 1) {
      loopar.setPage(this.__ENTITY__.name, 1);
      return await this.getList({ fields, filters, q, rowsOnly, unscoped });
    }

    return {...(rowsOnly ? {} : await this.__meta__(false)), ...{
        labels: this.getFieldListLabels(),
        fields: listFields,
        rows: rows,
        pagination: selfPagination,
        q
      }
    };
  }

  async getListToForm({ fields = null, filters = {}, q = null, rowsOnly = false, unscoped = false } = {}) {
    if (this.__ENTITY__.is_single) {
      return loopar.throw({
        code: 404,
        message: "This document is single, you can't get list"
      });
    }

    const pagination = {
      page: loopar.getPage(this.__ENTITY__.name),
      pageSize: 10,
      totalPages: 4,
      totalRecords: 1,
      sortBy: "id",
      sortOrder: "asc",
      __ENTITY__: this.__ENTITY__.name
    };

    const listFields = fields || this.getFieldListNames();

    if (this.__ENTITY__.name === 'Entity') {
      listFields.push('is_single');
    }

    const scoped = unscoped ? null : await requestOwnerFilter(this.__ENTITY__.name);
    const condition = combineSConditions(this.buildCondition(q), filters, scoped);

    pagination.totalRecords = await this.records(condition);

    pagination.totalPages = Math.ceil(pagination.totalRecords / pagination.pageSize);
    //const selfPagination = JSON.parse(JSON.stringify(pagination));
    loopar.db.pagination = pagination;
    // `__created_by__` rides along (not a visible column) so the client can
    // decide per row whether an 'own'-scoped action applies (AuthContext.canOn).
    // Only when the table has it: child/static entities are not auditable and
    // an app not yet updated lacks the column.
    const rows = await loopar.db.getList(this.__ENTITY__.name, [...listFields, "id", ...(await this.#ownerColumn())], condition);

    if (rows.length === 0 && pagination.page > 1) {
      loopar.setPage(this.__ENTITY__.name , 1);
      return await this.getList({ fields, filters, q, rowsOnly });
    }

    return rows;
  }

  buildConditionToSelect(q = null) {
    if (q === null) return {};
    if (q === '') return {};
    
    if (this.getFieldSelectNames().length === 1) {
      return { [this.getFieldSelectNames()]: { [Op.like]: `%${q}%` } };
    }
  }

  titleFields() {
    return this.__ENTITY__?.title_fields || 'name';
  }

  getSearchedFields() {
    return this.__ENTITY__?.search_fields || 'name';
  }

  getFieldSelectNames() {
    return Array.from(new Set([...this.getSearchedFields().split(',').filter(field => field !== ''), 'name']));
  }

  getFieldSelectLabels() {
    const fields = this.titleFields();
    return Array.from(new Set([...fields.split(',').filter(field => field !== '')]));
  }

  async getListToSelectElement(q = null) {
    const pagination = {
      page: 1,
      pageSize: 20,
      totalPages: 4,
      totalRecords: 1,
      sortBy: "id",
      sortOrder: "asc"
    };

    loopar.db.pagination = pagination;

    const listFields = this.getFieldSelectLabels();

    const condition = combineSConditions(this.buildConditionToSelect(q), await requestOwnerFilter(this.__ENTITY__.name));
    const rows = await loopar.db.getList(this.__ENTITY__.name, ["name", ...listFields], condition);

    pagination.totalRecords = await this.records(condition);
    pagination.totalPages = Math.ceil(pagination.totalRecords / pagination.pageSize);

    return Object.assign({
      title_fields: listFields,
      rows: rows
    });
  }

  async getValueDescriptive(name) {
    const listFields = this.getFieldSelectLabels();
    const values = await loopar.db.getRow(this.__ENTITY__.name, name, listFields);

    return Object.values(values).map(value => value).join(" - ");
  }

  /**
   * Titles of the records this document links to, for read-only renderings
   * (print, desk lists): `{ [Entity]: { [name]: "Title" } }`. `rows` are
   * records of this entity (default: this document). Covers the entity selects of
   * the document and of its child tables, one query per linked entity. A title
   * follows the linked entity's `title_fields` (joined " - ", like
   * getValueDescriptive); entities without title_fields are left out, their
   * name already is the title.
   */
  async linkTitles(rows = null) {
    rows ??= [await this.rawValues()];
    const wanted = {};

    const collect = async (structure, rows) => {
      for (const el of structure || []) {
        const data = el.data || {};

        if (el.element === SELECT) {
          const entity = linkedEntity(data.options);
          if (entity) {
            for (const row of rows) {
              const value = row?.[data.name];
              if (value !== null && value !== undefined && value !== "") {
                (wanted[entity] ??= new Set()).add(String(value));
              }
            }
          }
        } else if (el.element === FORM_TABLE) {
          const ref = linkedEntity(data.options) && loopar.getRef(data.options.trim());
          if (ref) {
            const childStructure = loopar.utils.JSONparse(
              await loopar.db.getValue(ref.__ENTITY__, "doc_structure", ref.__NAME__), []
            );
            const childRows = rows.flatMap(row => {
              const v = row?.[data.name];
              return Array.isArray(v) ? v : loopar.utils.JSONparse(v, []) || [];
            });
            await collect(childStructure, childRows);
          }
        }

        if (el.elements) await collect(el.elements, rows);
      }
    };

    await collect(loopar.utils.JSONparse(this.__ENTITY__.doc_structure, []), rows);

    const titles = {};
    for (const [entity, names] of Object.entries(wanted)) {
      const linked = await loopar.newDocument(entity);
      const found = await linked.titlesFor(names);
      if (found) titles[entity] = found;
    }

    return titles;
  }

  /** `{ [field]: Entity }` for the entity selects of this document (child tables aside). */
  linkedFields() {
    const out = {};
    const walk = (structure) => {
      for (const el of structure || []) {
        if (el.element === SELECT && el.data?.name) {
          const entity = linkedEntity(el.data.options);
          if (entity) out[el.data.name] = entity;
        }
        if (el.element !== FORM_TABLE) walk(el.elements);
      }
    };
    walk(loopar.utils.JSONparse(this.__ENTITY__.doc_structure, []));
    return out;
  }

  /** Whether a record named `name` exists (select link validation). */
  async linkExists(name) {
    return await loopar.db.count(this.__ENTITY__.name, { name }) > 0;
  }

  /**
   * `{ [name]: "Title" }` for some records of this entity (see linkTitles), or
   * null when the entity has no title_fields. Virtual entities without a
   * table override it.
   */
  async titlesFor(names) {
    const fields = this.getFieldSelectLabels().filter(f => f !== "name");
    if (!fields.length) return null;

    const rows = await loopar.db.getAll(this.__ENTITY__.name, ["name", ...fields], { name: { [Op.in]: [...names] } });
    return Object.fromEntries(rows.map(row => [
      row.name,
      fields.map(f => row[f]).filter(v => v !== null && v !== undefined && v !== "").join(" - ") || row.name,
    ]));
  }

  /**
   * One Kanban column: the records in workflow state `state`, newest first,
   * with the same search (`q`) and owner scope as the list. `pageSize` rows
   * per page; `total` is the column count.
   */
  async getBoardColumn({ field, state, q = null, page = 1, pageSize = 20 } = {}) {
    const name = this.__ENTITY__.name;
    const search = q ? { ...q } : null;
    if (search) delete search[field];

    const scoped = await requestOwnerFilter(name);
    const condition = combineSConditions(this.buildCondition(search), { [field]: state }, scoped);
    const where = loopar.db.buildWhereCb(condition);
    const ownerColumn = await this.#ownerColumn();
    const auditable = ownerColumn.length > 0 || this.__ENTITY__.__REF__?.is_audited === 1;

    const base = () => {
      let qb = loopar.db.qx()(name);
      if (where) qb = qb.where(where);
      if (auditable) qb = qb.whereNull("__deleted_at__");
      return qb;
    };

    const fields = [...new Set(["id", "name", field, ...this.getFieldListNames(), ...ownerColumn])];
    const [rows, countRow] = await Promise.all([
      base().select(fields).orderBy("id", "desc").limit(pageSize).offset((Math.max(1, page) - 1) * pageSize),
      base().count({ count: "id" }).first(),
    ]);

    return { state, rows, total: Number(countRow?.count || 0), page, pageSize };
  }

  async records(condition = []) {
    return await loopar.db.count(this.__ENTITY__.name, condition);
  }
}