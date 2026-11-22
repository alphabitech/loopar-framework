'use strict'

import { inferParentFilter, parseFilters } from './parent-filter.js';
import { __ } from '../global/i18n.js';
import CoreDocument from './core-document.js';
import { loopar } from '../loopar.js';
import { Op } from 'db-env';
import { multipleValues } from '../global/element-definition.js';
import { CREATED_BY_COLUMN } from '../global/audit.js';
import { requestOwnerFilter } from '../auth/record-scope.js';
import { clampPage, isListTarget } from './list-state.js';
import { readListSettings } from './list-settings.js';
import { isListableField, MAX_SORT_FIELDS } from '../global/list-settings.js';
import { parseFilterKey, normalizeFilter, matchFilter, filterKind, SYSTEM_DATE_FIELDS } from '../global/list-filters.js';
import { reportValueKey, emptyGroup, mergeGroup, groupValues, DEFAULT_GRAIN } from '../global/list-report.js';
import { dayOf, bucketOf } from '../global/date-buckets.js';
import { parseOptionLines } from '../global/select-options.js';
import { resolveColumnFormat } from '../global/element-definition.js';
import { calendarFields, isDay } from '../global/calendar.js';
import { treeFields } from '../global/tree.js';
import { geoFields } from '../global/geo.js';
import { workflowFor } from './workflow.js';

/** The entity a select links to, or null for inline options. */
function linkedEntity(options) {
  const entity = typeof options === "string" ? options.trim() : "";
  if (!entity || entity.includes("\n")) return null;
  return loopar.getRef(entity, false) ? entity : null;
}

/** Groups a report reads from the table before it stops (a date grouped by month merges many of them). */
const REPORT_MAX_SQL_GROUPS = 20000;
/** Groups a report shows. */
const REPORT_MAX_ROWS = 1000;
/** Records one export carries. */
export const EXPORT_MAX_ROWS = 50000;

const pad2 = (n) => String(n).padStart(2, "0");
/** A stored value as text for a file: dates as `YYYY-MM-DD[ HH:mm:ss]`. */
function plainValue(value) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) {
    if (isNaN(value)) return "";
    const day = `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`;
    const time = `${pad2(value.getHours())}:${pad2(value.getMinutes())}:${pad2(value.getSeconds())}`;
    return time === "00:00:00" ? day : `${day} ${time}`;
  }
  return typeof value === "object" ? JSON.stringify(value) : value;
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
   * Records of a virtual entity that pass the list's search (`q`, the same
   * `field` / `field.op` filters a table list takes) and `filters`
   * (`{ field: value }` equalities), matched in memory.
   */
  async #virtualMatches(q = null, filters = {}) {
    const plain = filters && typeof filters === "object" && !Array.isArray(filters) ? filters : {};
    const search = [];
    for (const [key, value] of Object.entries(q || {})) {
      if (value == null || String(value).trim() === "") continue;
      const { field, op } = parseFilterKey(key);
      const meta = this.#filterField(field);
      if (!op || !meta) { search.push({ field: key, value }); continue; }
      const kind = filterKind(meta);
      const filter = normalizeFilter({ field, op, value, kind });
      if (filter) search.push({ field, filter, kind });
    }

    // Same rules as buildCondition: choice fields match exactly, switches
    // only filter when on, everything else is a "contains".
    const matches = (row, { field, value, filter, kind }) => {
      if (!(field in row)) return true;
      if (filter) return matchFilter(row[field], filter, kind);
      const element = this.fields[field]?.element;
      const wanted = String(value).trim().toLowerCase();
      const actual = String(row[field] ?? "").toLowerCase();
      if ([SWITCH, CHECKBOX].includes(element)) return !loopar.utils.trueValue(value) || loopar.utils.trueValue(row[field]);
      if ([SELECT, CONNECTION, RADIO_GROUP].includes(element)) return actual === wanted;
      return actual.includes(wanted);
    };

    return matchRecords(await this.virtualRecords(), plain).filter(row => search.every((s) => matches(row, s)));
  }

  /**
   * List of a virtual entity: its records, searched (`q`: text contained in
   * each given field), filtered and paged in memory.
   */
  async #virtualList({ fields = null, filters = {}, q = null, page = null, sort = null, rowsOnly = false } = {}) {
    const listFields = fields || this.getFieldListNames();
    const all = await this.#virtualMatches(q, filters);

    // Sorted in memory (`?sort=plan,-status`, or the user's saved sort), by any field the records carry.
    const settings = !fields && isListTarget(this.__ENTITY__.name) ? await readListSettings(this.__ENTITY__.name) : null;
    const order = [].concat(sort ?? loopar.getSort(this.__ENTITY__.name) ?? settings?.sort ?? [])
      .filter((s) => s?.field && all.some(row => s.field in row))
      .map((s) => ({ field: s.field, dir: s.dir === "desc" ? "desc" : "asc" }));
    if (order.length) {
      const compare = (a, b) => String(a ?? "").localeCompare(String(b ?? ""), undefined, { numeric: true, sensitivity: "base" });
      all.sort((a, b) => {
        for (const { field, dir } of order) {
          const result = compare(a[field], b[field]);
          if (result) return dir === "desc" ? -result : result;
        }
        return 0;
      });
    }

    const pageSize = 10;
    const totalPages = Math.max(1, Math.ceil(all.length / pageSize));
    const current = clampPage(page || loopar.getPage(this.__ENTITY__.name), totalPages);

    return {...(rowsOnly ? {} : await this.__meta__(false)), ...{
      labels: this.getFieldListLabels(),
      fields: listFields,
      rows: all.slice((current - 1) * pageSize, current * pageSize),
      pagination: { page: current, pageSize, totalPages, totalRecords: all.length, sortBy: order[0]?.field || "id", sortOrder: order[0]?.dir || "asc", sort: order, __ENTITY__: this.__ENTITY__.name },
      list_settings: settings,
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
   * Columns every list row carries besides the visible ones: `id`, `name`
   * (the record's key: list links and cards open `?name=…`) and the title
   * fields (the list's title column), even when the entity doesn't show them
   * as columns.
   */
  #rowKeys(listFields, columns = null) {
    const titles = String(this.__ENTITY__.title_fields || "").split(",").map(f => f.trim())
      .filter(f => f && this.fields[f] && (!columns || columns.has(f)));
    return [...new Set(["id", "name", ...titles])].filter(k => !listFields.includes(k));
  }

  /** Names of the table's real columns, or null when they can't be read. */
  async #tableColumnNames() {
    try {
      const cols = await loopar.db.getTableColumns(this.__ENTITY__.name);
      return new Set([...cols.values()].map(meta => meta.name));
    } catch {
      return null;
    }
  }

  /**
   * Order of a list. `sort` = `[{ field, dir }]` (the URL's `?sort=plan,-status`,
   * see list-state.js, or the user's saved sort); only real columns of the
   * entity sort, anything else is dropped. `id` always closes the order so
   * pages never overlap.
   */
  #listOrder(sort, columns = null) {
    const seen = new Set();
    const valid = [].concat(sort || []).filter((s) => {
      const field = s?.field;
      const known = field && (field === "id" || field === "name" || !!this.fields[field]) && (!columns || columns.has(field));
      if (!known || seen.has(field)) return false;
      seen.add(field);
      return true;
    }).slice(0, MAX_SORT_FIELDS).map((s) => ({ field: s.field, dir: s.dir === "desc" ? "desc" : "asc" }));

    const last = valid[valid.length - 1];
    return {
      sort: valid,
      sortBy: valid[0]?.field || "id",
      sortOrder: valid[0]?.dir || "asc",
      orderBy: [
        ...valid.map((s) => ({ column: s.field, order: s.dir })),
        ...(seen.has("id") ? [] : [{ column: "id", order: last?.dir || "asc" }]),
      ],
    };
  }

  /**
   * Extra columns the user added to this list (settings `shown`): only plain,
   * readable fields of the entity that are real columns.
   */
  #extraListFields(settings, listFields, columns = null) {
    return (settings?.shown || []).filter((name) => {
      const field = this.fields[name];
      return field && !listFields.includes(name) && (!columns || columns.has(name))
        && isListableField({ element: field.element, data: field });
    });
  }

  getFieldListNames() {
    const fields = this.getFieldProperties('name');

    return fields.length === 0 ? ['name'] : fields;
  }

  getFieldListLabels() {
    const labels = this.getFieldProperties('label').map((l) => __(l));

    return labels.length === 0 ? [__('Name')] : labels;
  }

  /**
   * A field as filters, reports and exports see it (`{ element, data }`), or
   * null. Besides the entity's fields: the record dates of an audited table
   * (`__created_at__`, `__updated_at__`), when `columns` says it has them.
   */
  #filterField(name, columns = null) {
    const field = this.fields[name];
    if (field) return { element: field.element, data: field };
    if (SYSTEM_DATE_FIELDS[name] && columns?.has(name)) {
      return { element: "date_time", data: { name, label: SYSTEM_DATE_FIELDS[name] } };
    }
    return null;
  }

  /** Condition of a filter with an operator (global/list-filters.js). */
  #operatorCondition({ field, op, value }, kind) {
    const textual = kind === "text" || kind === "choice";
    // SQL leaves NULL out of every negative comparison: "is not X" includes the empty ones.
    const orEmpty = (condition) => ({ [Op.or]: [condition, { [field]: null }] });

    switch (op) {
      case "eq": return { [field]: value };
      case "ne": return orEmpty({ [field]: { [Op.ne]: value } });
      case "gt": case "gte": case "lt": case "lte": return { [field]: { [Op[op]]: value } };
      case "between": return { [field]: { [Op.between]: value } };
      case "in": return { [field]: { [Op.in]: value } };
      case "nin": return orEmpty({ [field]: { [Op.notIn]: value } });
      case "like": return { [field]: { [Op.like]: `%${value}%` } };
      case "nlike": return orEmpty({ [field]: { [Op.notLike]: `%${value}%` } });
      case "empty": return textual ? { [field]: { [Op.or]: [null, ""] } } : { [field]: null };
      case "filled": return textual
        ? { [Op.and]: [{ [field]: { [Op.ne]: null } }, { [field]: { [Op.ne]: "" } }] }
        : { [field]: { [Op.ne]: null } };
      default: return null;
    }
  }

  /**
   * Condition of a list's filters. `q`: `{ field: value }` (the search form:
   * text contains, a choice matches, a switch only when on) and
   * `{ "field.op": value }` (an operator: global/list-filters.js). Keys that
   * are not fields of the entity, or whose value doesn't fit, are removed
   * from `q`. `columns`: the table's column names, to accept record dates.
   */
  buildCondition(q = null, columns = null){

    if (q === null) return {};

    const conditions = [];

    Object.entries(q).forEach(([key, value]) => {
      const { field: name, op } = parseFilterKey(key);
      const meta = this.#filterField(name, columns);

      if (!meta || value === '' || value === null || value === undefined) {
        delete q[key];
        return;
      }

      if (op) {
        const kind = filterKind(meta);
        const filter = normalizeFilter({ field: name, op, value, kind });
        const condition = filter && this.#operatorCondition(filter, kind);
        condition ? conditions.push(condition) : delete q[key];
        return;
      }

      const field = this.fields[key];
      if (!field) {
        delete q[key];
        return;
      }

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

  async getList({ fields = null, filters = {}, q = null, page = null, pageSize = 10, sort = null, rowsOnly = false, unscoped = false } = {}) {
    if (this.__ENTITY__.is_single) {
      return loopar.throw({
        code: 404,
        message: "This document is single, you can't get list"
      });
    }

    if (loopar.getRef(this.__ENTITY__.name)?.is_virtual) {
      return await this.#virtualList({ fields, filters, q, page, sort, rowsOnly });
    }

    const columns = await this.#tableColumnNames();
    // The user's settings for this list (extra columns, saved sort): only for
    // the list the request targets, never for a list read on the side.
    const settings = !fields && isListTarget(this.__ENTITY__.name) ? await readListSettings(this.__ENTITY__.name) : null;
    // An explicit sort wins, then the URL's, then the one the user saved.
    const order = this.#listOrder(sort ?? loopar.getSort(this.__ENTITY__.name) ?? settings?.sort, columns);

    const pagination = {
      page: page || loopar.getPage(this.__ENTITY__.name),
      pageSize,
      totalPages: 4,
      totalRecords: 1,
      sortBy: order.sortBy,
      sortOrder: order.sortOrder,
      sort: order.sort,
      __ENTITY__: this.__ENTITY__.name
    };

    const listFields = fields || this.getFieldListNames();
    listFields.push(...this.#extraListFields(settings, listFields, columns));
    /*if (this.__ENTITY__.name === 'Document' && currentController.document !== "Document") {
       listFields.push('is_single');
    }*/

    if (this.__ENTITY__.name === 'Entity') {
      listFields.push('is_single');
    }

    // Scope 'own' (auth/record-scope.js): narrows rows AND the count so
    // pagination matches. Only when this entity is the one the request targets.
    const scoped = unscoped ? null : await requestOwnerFilter(this.__ENTITY__.name);
    const condition = combineSConditions(this.buildCondition(q, columns), filters, scoped);
    
    pagination.totalRecords = await this.records(condition);
    pagination.totalPages = Math.ceil(pagination.totalRecords / pagination.pageSize);
    pagination.page = clampPage(pagination.page, pagination.totalPages);
    const selfPagination = JSON.parse(JSON.stringify(pagination));
    loopar.db.pagination = pagination;

    // `__created_by__` rides along (not a visible column) so the client can
    // decide per row whether an 'own'-scoped action applies (AuthContext.canOn).
    // Only when the table has it: child/static entities are not auditable and
    // an app not yet updated lacks the column.
    const rows = await loopar.db.getList(this.__ENTITY__.name, [...listFields, ...this.#rowKeys(listFields, columns), ...(await this.#ownerColumn())], condition, { orderBy: order.orderBy });
    await this.#attachLinkTitles(rows);

    // Sums of the numeric columns over every record the filters match (not
    // just this page): only for the list the request targets.
    const totals = !fields && rows.length && isListTarget(this.__ENTITY__.name)
      ? await this.#listTotals(condition, listFields, columns)
      : null;

    return {...(rowsOnly ? {} : await this.__meta__(false)), ...{
        labels: this.getFieldListLabels(),
        fields: listFields,
        rows: rows,
        pagination: selfPagination,
        list_settings: settings,
        totals,
        // The table keeps record dates (created / updated): filters and reports offer them.
        record_dates: !!columns?.has("__created_at__"),
        q
      }
    };
  }

  async getListToForm({ fields = null, filters = {}, q = null, page = null, sort = null, rowsOnly = false, unscoped = false } = {}) {
    if (this.__ENTITY__.is_single) {
      return loopar.throw({
        code: 404,
        message: "This document is single, you can't get list"
      });
    }

    const columns = await this.#tableColumnNames();
    const order = this.#listOrder(sort ?? loopar.getSort(this.__ENTITY__.name), columns);

    const pagination = {
      page: page || loopar.getPage(this.__ENTITY__.name),
      pageSize: 10,
      totalPages: 4,
      totalRecords: 1,
      sortBy: order.sortBy,
      sortOrder: order.sortOrder,
      __ENTITY__: this.__ENTITY__.name
    };

    const listFields = fields || this.getFieldListNames();

    if (this.__ENTITY__.name === 'Entity') {
      listFields.push('is_single');
    }

    const scoped = unscoped ? null : await requestOwnerFilter(this.__ENTITY__.name);
    const condition = combineSConditions(this.buildCondition(q, columns), filters, scoped);

    pagination.totalRecords = await this.records(condition);

    pagination.totalPages = Math.ceil(pagination.totalRecords / pagination.pageSize);
    pagination.page = clampPage(pagination.page, pagination.totalPages);
    //const selfPagination = JSON.parse(JSON.stringify(pagination));
    loopar.db.pagination = pagination;
    // `__created_by__` rides along (not a visible column) so the client can
    // decide per row whether an 'own'-scoped action applies (AuthContext.canOn).
    // Only when the table has it: child/static entities are not auditable and
    // an app not yet updated lacks the column.
    const rows = await loopar.db.getList(this.__ENTITY__.name, [...listFields, ...this.#rowKeys(listFields, columns), ...(await this.#ownerColumn())], condition, { orderBy: order.orderBy });

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
    const condition = combineSConditions(this.buildCondition(search, await this.#tableColumnNames()), { [field]: state }, scoped);
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

  /**
   * Calendar (data): the records of this entity by date, with the same
   * search (`q`) and owner scope as the list. The date fields come from the
   * entity by convention (global/calendar.js).
   *
   *   { from, to }      records whose range touches those days (at most `limit`)
   *   { unscheduled }   records without a start date, newest first, paged
   *
   * Not `get…`: every field gets a `get<Field>` accessor, and an entity with a
   * `calendar` field (Event) would shadow a `getCalendar` method.
   */
  async calendarRows({ from = null, to = null, unscheduled = false, q = null, page = 1, pageSize = 30, limit = 500 } = {}) {
    const name = this.__ENTITY__.name;
    const calendar = calendarFields(this.__ENTITY__.doc_structure);
    if (!calendar) loopar.throw(`${name} has no date field to show on a calendar.`);
    if (!unscheduled && !(isDay(from) && isDay(to) && from <= to)) {
      loopar.throw({ code: 400, message: "Calendar range: cal_from and cal_to must be days (YYYY-MM-DD)." });
    }

    const { start, end, time, allDay, repeat, assignee } = calendar;
    const repeatFields = repeat ? [repeat.freq, repeat.interval, repeat.days, repeat.until].filter(Boolean) : [];
    const search = q ? { ...q } : null;
    if (search) { delete search[start]; if (end) delete search[end]; }

    const scoped = await requestOwnerFilter(name);
    const where = loopar.db.buildWhereCb(combineSConditions(this.buildCondition(search, await this.#tableColumnNames()), scoped));
    const ownerColumn = await this.#ownerColumn();
    const auditable = ownerColumn.length > 0 || this.__ENTITY__.__REF__?.is_audited === 1;
    const workflow = await workflowFor(name);

    const lower = time ? `${from} 00:00:00` : from;
    const upper = time ? `${to} 23:59:59` : to;

    const base = () => {
      let qb = loopar.db.qx()(name);
      if (where) qb = qb.where(where);
      if (auditable) qb = qb.whereNull("__deleted_at__");
      if (unscheduled) return qb.whereNull(start);

      qb = qb.where(start, "<=", upper);
      // A range touches the window when it ends inside or after it; without
      // an end date the record lives on its start day.
      const touches = (w) => (end
        ? w.where((r) => r.where(end, ">=", lower).orWhere((o) => o.whereNull(end).where(start, ">=", lower)))
        : w.where(start, ">=", lower));
      if (!repeat) return touches(qb);

      // A recurring record that started earlier may repeat inside the window
      // (until its last day): the client expands it (global/calendar.js).
      const recurs = (w) => {
        w.whereNotNull(repeat.freq).whereNotIn(repeat.freq, ["", "None"]);
        if (repeat.until) w.where((u) => u.whereNull(repeat.until).orWhere(repeat.until, ">=", from));
      };
      return qb.where((w) => w.where(touches).orWhere(recurs));
    };

    const fields = [...new Set([
      "id", "name", start, ...(end ? [end] : []), ...(allDay ? [allDay] : []), ...repeatFields, ...(assignee ? [assignee] : []), ...(workflow ? [workflow.field] : []),
      ...this.getFieldSelectLabels().map((f) => f.trim()), ...this.getFieldListNames(), ...ownerColumn,
    ].filter(Boolean))];

    if (unscheduled) {
      const [rows, countRow] = await Promise.all([
        base().select(fields).orderBy("id", "desc").limit(pageSize).offset((Math.max(1, page) - 1) * pageSize),
        base().count({ count: "id" }).first(),
      ]);
      return { rows, total: Number(countRow?.count || 0), page, pageSize };
    }

    const rows = await base().select(fields).orderBy(start, "asc").limit(limit + 1);
    return {
      from, to,
      rows: rows.slice(0, limit),
      truncated: rows.length > limit,
      // What the calendar needs to draw rows of an entity it has no meta of (a layer).
      titleFields: this.getFieldSelectLabels().map((f) => f.trim()).filter(Boolean),
      states: workflow ? { field: workflow.field, colors: Object.fromEntries(workflow.states.map((s) => [s.state, s.color || "gray"])) } : null,
    };
  }

  /**
   * Tree (data): every record of this entity the user may list (at most
   * `limit`), with the columns of the list, for entities that nest by
   * convention (global/tree.js). The tree always loads whole: with a search
   * (`q`), `matches` names the records it finds and the client keeps them
   * with the ones above them.
   *
   * → { parent, editable, rows, matches, truncated, titleFields }
   */
  async treeRows({ q = null, limit = 2000 } = {}) {
    const name = this.__ENTITY__.name;
    const tree = treeFields(this.__ENTITY__.doc_structure, name);
    if (!tree) loopar.throw(`${name} has no parent field to show as a tree.`);

    const columns = await this.#tableColumnNames();
    const scoped = await requestOwnerFilter(name);
    const ownerColumn = await this.#ownerColumn();
    const auditable = await this.#softDeletes();
    const base = (condition) => {
      let qb = loopar.db.qx()(name);
      const where = loopar.db.buildWhereCb(condition);
      if (where) qb = qb.where(where);
      if (auditable) qb = qb.whereNull("__deleted_at__");
      return qb;
    };

    const titleFields = this.getFieldSelectLabels().map((f) => f.trim()).filter(Boolean);
    // The list's columns, with the ones the user added to it.
    const listed = this.getFieldListNames();
    const settings = isListTarget(name) ? await readListSettings(name) : null;
    const fields = [...new Set(["id", "name", tree.parent, ...titleFields, ...listed, ...this.#extraListFields(settings, listed, columns), ...ownerColumn])]
      .filter((f) => f && (!columns || columns.has(f)));
    const order = titleFields.find((f) => fields.includes(f)) || "name";

    const search = q ? { ...q } : null;
    if (search) delete search[tree.parent];
    const filtered = !!search && Object.keys(search).length > 0;

    const [all, found] = await Promise.all([
      base(combineSConditions(scoped)).select(fields).orderBy(order, "asc").limit(limit + 1),
      filtered ? base(combineSConditions(this.buildCondition(search, columns), scoped)).select("name") : null,
    ]);
    const rows = all.slice(0, limit);
    await this.#attachLinkTitles(rows);

    return {
      parent: tree.parent,
      editable: tree.editable,
      rows,
      matches: found ? found.map((r) => r.name) : null,
      truncated: all.length > limit,
      titleFields,
    };
  }

  /**
   * Map (data): the records of this entity that have a place (global/geo.js),
   * with the same search (`q`) and owner scope as the list, at most `limit`.
   * `unplaced` counts the matching records without coordinates: they exist,
   * the map just can't show them.
   *
   * → { latitude, longitude, address, rows, truncated, unplaced, titleFields, state }
   */
  async mapRows({ q = null, limit = 2000 } = {}) {
    const name = this.__ENTITY__.name;
    const geo = geoFields(this.__ENTITY__.doc_structure);
    if (!geo) loopar.throw(`${name} has no latitude and longitude fields to show on a map.`);

    const columns = await this.#tableColumnNames();
    const scoped = await requestOwnerFilter(name);
    const where = loopar.db.buildWhereCb(combineSConditions(this.buildCondition(q, columns), scoped));
    const ownerColumn = await this.#ownerColumn();
    const auditable = await this.#softDeletes();
    const workflow = await workflowFor(name);

    const base = () => {
      let qb = loopar.db.qx()(name);
      if (where) qb = qb.where(where);
      if (auditable) qb = qb.whereNull("__deleted_at__");
      return qb;
    };
    const placed = (qb) => qb.whereNotNull(geo.latitude).whereNotNull(geo.longitude);

    const titleFields = this.getFieldSelectLabels().map((f) => f.trim()).filter(Boolean);
    const fields = [...new Set([
      "id", "name", geo.latitude, geo.longitude, ...geo.address, ...titleFields,
      ...(workflow ? [workflow.field] : []), ...this.getFieldListNames(), ...ownerColumn,
    ])].filter((f) => f && (!columns || columns.has(f)));

    const [found, total] = await Promise.all([
      placed(base()).select(fields).orderBy("id", "desc").limit(limit + 1),
      base().count({ count: "id" }).first(),
    ]);
    const rows = found.slice(0, limit);
    await this.#attachLinkTitles(rows);
    const onMap = found.length > limit
      ? Number((await placed(base()).count({ count: "id" }).first())?.count || 0)
      : rows.length;

    return {
      latitude: geo.latitude,
      longitude: geo.longitude,
      address: geo.address,
      rows,
      truncated: found.length > limit,
      unplaced: Math.max(0, Number(total?.count || 0) - onMap),
      titleFields,
      state: workflow ? { field: workflow.field, colors: Object.fromEntries(workflow.states.map((s) => [s.state, s.color || "gray"])) } : null,
    };
  }

  /**
   * A record can't hang from itself nor from a record below it: the tree
   * would lose the whole branch. Error messages, empty when the parent is fine.
   */
  async treeParentErrors() {
    // Documents without an entity (the app installer) have no tree.
    if (!this.__ENTITY__) return [];
    const name = this.__ENTITY__.name;
    const tree = !this.__ENTITY__.is_single && treeFields(this.__ENTITY__.doc_structure, name);
    if (!tree) return [];
    const own = this.name;
    let above = this.fields?.[tree.parent]?.value;
    const filled = (v) => v !== null && v !== undefined && v !== "";
    if (!filled(above) || !filled(own)) return [];

    const label = __(this.fields[tree.parent].label || tree.parent);
    if (String(above) === String(own)) return [__("{0}: a record can't be its own parent.", [label])];
    if (this.__IS_NEW__) return [];

    const seen = new Set();
    while (filled(above) && !seen.has(String(above))) {
      seen.add(String(above));
      const [row] = await loopar.db.getAll(name, ["name", tree.parent], { name: above });
      above = row?.[tree.parent];
      if (filled(above) && String(above) === String(own)) {
        return [__("{0}: {1} is below this record, it can't be its parent.", [label, [...seen][0]])];
      }
    }
    return [];
  }

  /** Whether the table soft-deletes: queries on the raw builder leave deleted rows out by hand. */
  async #softDeletes() {
    return (await this.#ownerColumn()).length > 0 || this.__ENTITY__.__REF__?.is_audited === 1;
  }

  /** A numeric field whose sum means something (not a percentage, a rating or a slider). */
  #summable(meta) {
    return filterKind(meta) === "number" && !["range", "rating"].includes(meta.element) && resolveColumnFormat(meta) !== "percent";
  }

  /**
   * `{ field: sum }` of the list's numeric columns over every record
   * `condition` matches, or null when the list has none.
   */
  async #listTotals(condition, listFields, columns = null) {
    const numeric = listFields.filter((name) => {
      const meta = this.fields[name] && this.#filterField(name);
      return meta && (!columns || columns.has(name)) && this.#summable(meta);
    });
    if (!numeric.length) return null;

    try {
      let qb = loopar.db.qx()(this.__ENTITY__.name);
      const where = loopar.db.buildWhereCb(condition);
      if (where) qb = qb.where(where);
      if (await this.#softDeletes()) qb = qb.whereNull("__deleted_at__");
      for (const name of numeric) qb = qb.sum({ [name]: name });
      const row = await qb.first();
      return Object.fromEntries(numeric.map((name) => [name, row?.[name] == null ? null : Number(row[name])]));
    } catch (e) {
      console.warn(`[list] totals of ${this.__ENTITY__.name} failed:`, e?.message || e);
      return null;
    }
  }

  /**
   * Report (data): this entity's records grouped and aggregated, with the
   * same search (`q`) and owner scope as the list. See global/list-report.js.
   *
   *   groups   [{ field, grain }]   up to two fields; a date groups by `grain`
   *   values   [{ fn, field }]      sum | avg | min | max of numeric fields
   *
   * The table groups by the stored values (SUM / COUNT / MIN / MAX, the same
   * on every database); dates are bucketed here and their groups merged.
   *
   * → { groups, values, rows: [{ keys, labels, count, values }], totals, groupCount, truncated }
   */
  async reportData({ groups = [], values = [], q = null } = {}) {
    const name = this.__ENTITY__.name;
    const virtual = !!loopar.getRef(name)?.is_virtual;
    const columns = virtual ? null : await this.#tableColumnNames();

    // A plain, readable value of the entity (no secrets, nothing hidden) that is a real column.
    const usable = (field) => {
      const meta = this.#filterField(field, columns);
      if (!meta || (columns && !columns.has(field))) return null;
      if (this.fields[field] && !isListableField(meta)) return null;
      return meta;
    };

    const groupDefs = groups.map(({ field, grain }) => {
      const meta = usable(field);
      if (!meta) loopar.throw({ code: 400, message: `Field "${field}" can't group a report of ${name}.` });
      const kind = filterKind(meta);
      return {
        field, kind,
        label: __(meta.data.label || field),
        grain: ["date", "datetime"].includes(kind) ? (grain || DEFAULT_GRAIN) : null,
        element: meta.element,
        options: meta.data.options,
      };
    });

    const valueDefs = values.map(({ fn, field }) => {
      const meta = usable(field);
      if (!meta || filterKind(meta) !== "number") {
        loopar.throw({ code: 400, message: `Field "${field}" is not a number of ${name}.` });
      }
      return { fn, field, key: reportValueKey({ fn, field }), label: __(meta.data.label || field), format: resolveColumnFormat(meta) };
    });

    const groupFields = groupDefs.map((g) => g.field);
    const valueFields = [...new Set(valueDefs.map((v) => v.field))];

    // Partial results: one per stored group (table) or per record (virtual).
    let partials;
    if (virtual) {
      partials = (await this.#virtualMatches(q)).map((row) => ({
        raw: groupFields.map((f) => row[f]),
        count: 1,
        fields: Object.fromEntries(valueFields.map((f) => {
          const n = row[f] === null || row[f] === undefined || row[f] === "" ? NaN : Number(row[f]);
          return [f, Number.isFinite(n) ? { sum: n, n: 1, min: n, max: n } : { n: 0 }];
        })),
      }));
    } else {
      const scoped = await requestOwnerFilter(name);
      const where = loopar.db.buildWhereCb(combineSConditions(this.buildCondition(q ? { ...q } : null, columns), scoped));

      let qb = loopar.db.qx()(name);
      if (where) qb = qb.where(where);
      if (await this.#softDeletes()) qb = qb.whereNull("__deleted_at__");
      qb = qb.select(groupFields).count({ __count: "id" });
      valueFields.forEach((f, i) => {
        qb = qb.sum({ [`s${i}`]: f }).count({ [`n${i}`]: f }).min({ [`lo${i}`]: f }).max({ [`hi${i}`]: f });
      });
      if (groupFields.length) qb = qb.groupBy(groupFields);

      partials = (await qb.limit(REPORT_MAX_SQL_GROUPS + 1)).map((row) => ({
        raw: groupFields.map((f) => row[f]),
        count: row.__count,
        fields: Object.fromEntries(valueFields.map((f, i) => [f, { sum: row[`s${i}`], n: row[`n${i}`], min: row[`lo${i}`], max: row[`hi${i}`] }])),
      }));
    }
    const overflow = partials.length > REPORT_MAX_SQL_GROUPS;
    if (overflow) partials.length = REPORT_MAX_SQL_GROUPS;

    // Group key as shown: a date becomes its bucket, an empty value is "".
    const keyOf = (value, def) => {
      if (value === null || value === undefined || value === "") return "";
      if (def.grain) {
        const day = dayOf(value);
        return day ? bucketOf(day, def.grain) : "";
      }
      if (def.kind === "bool") return loopar.utils.trueValue(value) ? "1" : "0";
      return String(plainValue(value));
    };

    const merged = new Map();
    const totals = emptyGroup();
    for (const partial of partials) {
      const keys = partial.raw.map((value, i) => keyOf(value, groupDefs[i]));
      const id = JSON.stringify(keys);
      let group = merged.get(id);
      if (!group) merged.set(id, group = { keys, ...emptyGroup() });
      mergeGroup(group, partial);
      mergeGroup(totals, partial);
    }

    // By key, first group first; empty values close each level.
    const compare = (a, b) => {
      if (a === b) return 0;
      if (a === "") return 1;
      if (b === "") return -1;
      return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
    };
    const rows = [...merged.values()].sort((a, b) => {
      for (let i = 0; i < a.keys.length; i++) {
        const result = compare(a.keys[i], b.keys[i]);
        if (result) return result;
      }
      return 0;
    }).slice(0, REPORT_MAX_ROWS);

    // What a key reads as: the option's label, the linked record's title, Yes / No.
    const labelMaps = await Promise.all(groupDefs.map(async (def, i) => {
      if (def.kind === "bool") return { "1": __("Yes"), "0": __("No") };
      if (def.element === CONNECTION) {
        const entity = linkedEntity(def.options);
        if (!entity) return null;
        try {
          const titles = await this.linkTitles(rows.filter((r) => r.keys[i] !== "").map((r) => ({ [def.field]: r.keys[i] })));
          return titles?.[entity] || null;
        } catch (e) {
          console.warn(`[report] link titles of ${name}.${def.field} failed:`, e?.message || e);
          return null;
        }
      }
      if ([SELECT, RADIO_GROUP].includes(def.element) && typeof def.options === "string") {
        return Object.fromEntries(parseOptionLines(def.options).map((o) => [String(o.value), __(o.label ?? o.value)]));
      }
      return null;
    }));

    return {
      groups: groupDefs.map(({ field, label, kind, grain }) => ({ field, label, kind, grain })),
      values: valueDefs.map(({ key, fn, field, label, format }) => ({ key, fn, field, label, format })),
      rows: rows.map((group) => ({
        keys: group.keys,
        labels: group.keys.map((key, i) => labelMaps[i]?.[key] ?? null),
        count: group.count,
        values: groupValues(group, valueDefs),
      })),
      totals: { count: totals.count, values: groupValues(totals, valueDefs) },
      groupCount: merged.size,
      truncated: overflow || merged.size > REPORT_MAX_ROWS,
    };
  }

  /**
   * Export (data): the list's records as a table of text — every record the
   * search (`q`) matches or only `names`, in the list's order, with the same
   * owner scope. Values read as the list shows them (option labels, linked
   * titles, Yes / No); `name` always comes first so a row can be traced back.
   *
   *   fields   columns to export, in order (default: the list's columns);
   *            only list columns and plain readable fields are accepted
   *
   * → { header: [label], rows: [[cell]], truncated }
   */
  async exportRows({ q = null, sort = null, fields = null, names = null, limit = EXPORT_MAX_ROWS } = {}) {
    const name = this.__ENTITY__.name;
    const virtual = !!loopar.getRef(name)?.is_virtual;
    const columns = virtual ? null : await this.#tableColumnNames();
    const settings = isListTarget(name) ? await readListSettings(name) : null;

    const listNames = this.getFieldListNames();
    const allowed = (f) => {
      const field = this.fields[f];
      if (!field || field.element === PASSWORD || (columns && !columns.has(f))) return false;
      return listNames.includes(f) || isListableField({ element: field.element, data: field });
    };
    const wanted = Array.isArray(fields) && fields.length
      ? fields.map(String)
      : [...listNames, ...this.#extraListFields(settings, listNames, columns)];
    const exported = [...new Set(["name", ...wanted])].filter((f) => f === "name" || allowed(f)).slice(0, 200);

    const picked = Array.isArray(names) && names.length ? names.map(String).slice(0, limit) : null;

    let rows;
    if (virtual) {
      rows = (await this.#virtualMatches(q)).filter((row) => !picked || picked.includes(String(row.name)));
    } else {
      const scoped = await requestOwnerFilter(name);
      const condition = combineSConditions(
        this.buildCondition(q ? { ...q } : null, columns),
        picked ? { name: { [Op.in]: picked } } : null,
        scoped,
      );
      const order = this.#listOrder(sort ?? loopar.getSort(name) ?? settings?.sort, columns);

      let qb = loopar.db.qx()(name);
      const where = loopar.db.buildWhereCb(condition);
      if (where) qb = qb.where(where);
      if (await this.#softDeletes()) qb = qb.whereNull("__deleted_at__");
      rows = await qb.select(exported).orderBy(order.orderBy).limit(limit + 1);
    }

    const truncated = rows.length > limit;
    if (truncated) rows.length = limit;
    await this.#attachLinkTitles(rows);

    const optionLabels = {};
    for (const f of exported) {
      const field = this.fields[f];
      if (field && [SELECT, RADIO_GROUP].includes(field.element) && typeof field.options === "string") {
        optionLabels[f] = Object.fromEntries(parseOptionLines(field.options).map((o) => [String(o.value), __(o.label ?? o.value)]));
      }
    }

    const cell = (row, f) => {
      const value = row[f];
      const title = row.__titles__?.[f];
      if (title !== undefined && title !== null && title !== "") return title;
      if (value === null || value === undefined || value === "") return "";
      const element = this.fields[f]?.element;
      if ([SWITCH, CHECKBOX].includes(element)) return loopar.utils.trueValue(value) ? __("Yes") : __("No");
      if (optionLabels[f]) {
        return [1, "1", true, "true"].includes(this.fields[f].multiple)
          ? multipleValues(value).map((v) => optionLabels[f][String(v)] ?? v).join(", ")
          : optionLabels[f][String(value)] ?? value;
      }
      return plainValue(value);
    };

    return {
      header: exported.map((f) => __(this.fields[f]?.label || (f === "name" ? "Name" : f))),
      rows: rows.map((row) => exported.map((f) => cell(row, f))),
      truncated,
    };
  }

  async records(condition = []) {
    return await loopar.db.count(this.__ENTITY__.name, condition);
  }
}