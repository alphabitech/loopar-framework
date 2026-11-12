'use strict'

import { inferParentFilter, parseFilters } from './parent-filter.js';
import { __ } from '../global/i18n.js';
import CoreDocument from './core-document.js';
import { loopar } from '../loopar.js';
import { Op } from 'db-env';
import { multipleValues } from '../global/element-definition.js';
import { CREATED_BY_COLUMN } from '../global/audit.js';
import { requestOwnerFilter } from '../auth/record-scope.js';
import { clampPage } from './list-state.js';

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


/** Rows whose fields equal every `filter` value (compared as text: 1 == "1"). */
export function matchRecords(rows, filter = {}) {
  const entries = Object.entries(filter || {});
  if (!entries.length) return rows;
  return rows.filter(row => entries.every(([field, value]) => String(row?.[field] ?? "") === String(value ?? "")));
}

export default class BaseDocument extends CoreDocument {
  /**
   * Virtual entities (no table: an API, a file…): every record as a plain
   * row, fresh from its source. The base has no source, so it has no records;
   * the entity's document overrides this once and desk figures (number cards,
   * shortcut counters, quick lists) work from it.
   */
  async virtualRecords() {
    return [];
  }

  /**
   * List of a virtual entity: its records, searched (`q`: text contained in
   * each given field), filtered and paged in memory.
   */
  async #virtualList({ fields = null, filters = {}, q = null, page = null, rowsOnly = false } = {}) {
    const listFields = fields || this.getFieldListNames();
    const search = Object.entries(q || {}).filter(([, v]) => v != null && String(v).trim() !== "");
    const plain = filters && typeof filters === "object" && !Array.isArray(filters) ? filters : {};
    // Same rules as buildCondition: choice fields match exactly, switches
    // only filter when on, everything else is a "contains".
    const matches = (row, field, value) => {
      if (!(field in row)) return true;
      const element = this.fields[field]?.element;
      const wanted = String(value).trim().toLowerCase();
      const actual = String(row[field] ?? "").toLowerCase();
      if ([SWITCH, CHECKBOX].includes(element)) return !loopar.utils.trueValue(value) || loopar.utils.trueValue(row[field]);
      if ([SELECT, CONNECTION, RADIO_GROUP].includes(element)) return actual === wanted;
      return actual.includes(wanted);
    };
    const all = matchRecords(await this.virtualRecords(), plain).filter(row =>
      search.every(([field, value]) => matches(row, field, value))
    );

    const pageSize = 10;
    const totalPages = Math.max(1, Math.ceil(all.length / pageSize));
    const current = clampPage(page || loopar.getPage(this.__ENTITY__.name), totalPages);

    return {...(rowsOnly ? {} : await this.__meta__(false)), ...{
      labels: this.getFieldListLabels(),
      fields: listFields,
      rows: all.slice((current - 1) * pageSize, current * pageSize),
      pagination: { page: current, pageSize, totalPages, totalRecords: all.length, sortBy: "id", sortOrder: "asc", __ENTITY__: this.__ENTITY__.name },
      q,
    }};
  }

  /** Records of a virtual entity matching `filter` ({ field: value } equalities). */
  async virtualCount(filter = {}) {
    return matchRecords(await this.virtualRecords(), filter).length;
  }

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

  /**
   * Columns every list row carries besides the visible ones: `id`, and `name`
   * (the record's key: list links and cards open `?name=…`) even when the
   * entity doesn't show it as a column.
   */
  #rowKeys(listFields) {
    return ["id", ...(listFields.includes("name") ? [] : ["name"])];
  }

  getFieldListNames() {
    const fields = this.getFieldProperties('name');

    return fields.length === 0 ? ['name'] : fields;
  }

  getFieldListLabels() {
    const labels = this.getFieldProperties('label').map((l) => __(l));

    return labels.length === 0 ? [__('Name')] : labels;
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
        const isSelectType = [SELECT, CONNECTION, RADIO_GROUP, SWITCH, CHECKBOX].includes(field.element);
        
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

  /**
   * Lists show the linked record's title, not its code: each row gets
   * `__titles__ = { field: title }` for its select fields that link to an
   * entity with titles (see linkTitles). The values themselves stay codes,
   * so links and filters keep working.
   */
  async #attachLinkTitles(rows) {
    if (!rows?.length) return;
    const links = [];
    const walk = (structure) => {
      for (const el of structure || []) {
        if (el.element === CONNECTION && el.data?.name) {
          const entity = linkedEntity(el.data.options);
          if (entity) links.push([el.data.name, entity, [1, "1", true, "true"].includes(el.data.multiple)]);
        }
        if (el.element !== FORM_TABLE && el.elements) walk(el.elements);
      }
    };
    walk(loopar.utils.JSONparse(this.__ENTITY__.doc_structure, []));
    if (!links.length) return;

    let titles;
    try {
      titles = await this.linkTitles(rows);
    } catch (e) {
      console.warn(`[list] link titles of ${this.__ENTITY__.name} failed:`, e?.message || e);
      return;
    }
    for (const row of rows) {
      for (const [field, entity, multiple] of links) {
        const value = row[field];
        if (value == null || value === "") continue;
        // A multiple connection lists every linked title.
        const title = multiple
          ? multipleValues(value).map((v) => titles[entity]?.[String(v)] ?? v).join(", ")
          : titles[entity]?.[String(value)];
        if (title != null && title !== "") (row.__titles__ ??= {})[field] = title;
      }
    }
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

  async getList({ fields = null, filters = {}, q = null, page = null, pageSize = 10, rowsOnly = false, unscoped = false } = {}) {
    if (this.__ENTITY__.is_single) {
      return loopar.throw({
        code: 404,
        message: "This document is single, you can't get list"
      });
    }

    if (loopar.getRef(this.__ENTITY__.name)?.is_virtual) {
      return await this.#virtualList({ fields, filters, q, page, rowsOnly });
    }

    const pagination = {
      page: page || loopar.getPage(this.__ENTITY__.name),
      pageSize,
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
    pagination.page = clampPage(pagination.page, pagination.totalPages);
    const selfPagination = JSON.parse(JSON.stringify(pagination));
    loopar.db.pagination = pagination;

    // `__created_by__` rides along (not a visible column) so the client can
    // decide per row whether an 'own'-scoped action applies (AuthContext.canOn).
    // Only when the table has it: child/static entities are not auditable and
    // an app not yet updated lacks the column.
    const rows = await loopar.db.getList(this.__ENTITY__.name, [...listFields, ...this.#rowKeys(listFields), ...(await this.#ownerColumn())], condition);
    await this.#attachLinkTitles(rows);

    return {...(rowsOnly ? {} : await this.__meta__(false)), ...{
        labels: this.getFieldListLabels(),
        fields: listFields,
        rows: rows,
        pagination: selfPagination,
        q
      }
    };
  }

  async getListToForm({ fields = null, filters = {}, q = null, page = null, rowsOnly = false, unscoped = false } = {}) {
    if (this.__ENTITY__.is_single) {
      return loopar.throw({
        code: 404,
        message: "This document is single, you can't get list"
      });
    }

    const pagination = {
      page: page || loopar.getPage(this.__ENTITY__.name),
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
    pagination.page = clampPage(pagination.page, pagination.totalPages);
    //const selfPagination = JSON.parse(JSON.stringify(pagination));
    loopar.db.pagination = pagination;
    // `__created_by__` rides along (not a visible column) so the client can
    // decide per row whether an 'own'-scoped action applies (AuthContext.canOn).
    // Only when the table has it: child/static entities are not auditable and
    // an app not yet updated lacks the column.
    const rows = await loopar.db.getList(this.__ENTITY__.name, [...listFields, ...this.#rowKeys(listFields), ...(await this.#ownerColumn())], condition);

    return rows;
  }

  buildConditionToSelect(q = null) {
    if (q === null || q === undefined || q === '') return {};

    // Any of the searched fields (search_fields + name) may match.
    const fields = this.getFieldSelectNames();
    const likes = fields.map(field => ({ [field]: { [Op.like]: `%${q}%` } }));
    return likes.length === 1 ? likes[0] : { [Op.or]: likes };
  }

  /** Names of the fields declared in this entity's structure. */
  declaredFieldNames() {
    return new Set(["name", ...Object.keys(this.fields || {})]);
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

  /**
   * Records offered by a `connection` field: searched by `q`, optionally
   * restricted to `filterField = filterValue` (cascade from a parent field)
   * and ordered by `groupBy` so the client can show them under its values.
   * Only fields declared by the entity may filter or group.
   */
  async getListToSelectElement(q = null, { page = 1, limit = 20, filterField = null, filterValue = null, groupBy = null, filters = null, sourceEntity = null, parentField = null } = {}) {
    const declared = this.declaredFieldNames();
    const group = groupBy && declared.has(groupBy) ? groupBy : null;
    const pageSize = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));

    const pagination = {
      page: Math.max(1, parseInt(page, 10) || 1),
      pageSize,
      totalPages: 1,
      totalRecords: 0,
      sortBy: group || "id",
      sortOrder: "asc"
    };

    loopar.db.pagination = pagination;

    const listFields = this.getFieldSelectLabels();
    // Cascade: the field to compare is given, or inferred from how the
    // parent field of the form connects to this entity.
    const cascadeField = parentField
      ? inferParentFilter({ target: this.__ENTITY__.name, source: sourceEntity, parent: parentField, parentFilter: filterField })
      : filterField;
    const parentFilter = cascadeField && declared.has(cascadeField) ? { [cascadeField]: filterValue ?? null } : {};
    const staticFilter = Object.fromEntries(Object.entries(parseFilters(filters)).filter(([k]) => declared.has(k)));

    const condition = combineSConditions(
      this.buildConditionToSelect(q),
      parentFilter,
      staticFilter,
      await requestOwnerFilter(this.__ENTITY__.name)
    );
    const fields = [...new Set(["name", ...listFields, ...(group ? [group] : [])])];
    const rows = await loopar.db.getList(this.__ENTITY__.name, fields, condition);

    pagination.totalRecords = await this.records(condition);
    pagination.totalPages = Math.max(1, Math.ceil(pagination.totalRecords / pagination.pageSize));

    return {
      title_fields: listFields,
      rows,
      pagination: { page: pagination.page, pages: pagination.totalPages, total: pagination.totalRecords },
    };
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

        if (el.element === CONNECTION) {
          const entity = linkedEntity(data.options);
          if (entity) {
            const multiple = [1, "1", true, "true"].includes(data.multiple);
            for (const row of rows) {
              const value = row?.[data.name];
              if (value === null || value === undefined || value === "") continue;
              for (const v of multiple ? multipleValues(value) : [value]) {
                (wanted[entity] ??= new Set()).add(String(v));
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
        if (el.element === CONNECTION && el.data?.name) {
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