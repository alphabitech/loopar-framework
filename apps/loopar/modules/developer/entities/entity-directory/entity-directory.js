'use strict';

import { BaseDocument, loopar, parseFilters, findFieldMeta } from 'loopar';

const PAGE_SIZE = 20;

/** Elements whose value is one choice: what a group or a cascade can compare. */
const DISCRETE = new Set(['select', 'radio_group', 'connection', 'switch', 'checkbox']);
/** Not comparable as one value: long text, secrets, files, structures. */
const NOT_SCALAR = new Set(['form_table', 'textarea', 'markdown_input', 'password', 'file_input', 'image_input', 'designer', 'metadata', 'tailwind', 'slot']);

/**
 * Read-only directory of the tenant's entities, built from the refs registry
 * (no table). Connections pick an entity or one of its fields from here
 * instead of typing names by hand. The connection's `filters` choose what is
 * listed (`mode = …`):
 *  - records (default): entities that hold records — not singles (pages,
 *    forms, views…) nor child tables;
 *  - child: child tables only (form_table);
 *  - all: every entity and page;
 *  - fields: the fields of an entity, given by the parent value (cascade) or
 *    `entity = …`; `kinds = discrete` (default) keeps one-choice fields —
 *    select, radio group, single connection, switch, checkbox —, `scalar`
 *    any field holding one comparable value (no long text, files, lists),
 *    `all` every stored field but child tables.
 * Values stored are entity names (or field names in fields mode).
 */
export default class EntityDirectory extends BaseDocument {
  constructor(props) {
    super(props);
  }

  async __init__(ifNotFound) {
    if (this.__DOCUMENT_NAME__) {
      const [row] = EntityDirectory.rows({ mode: 'all', names: [this.__DOCUMENT_NAME__] });
      if (!row && ifNotFound === 'throw') {
        loopar.throw({ code: 404, message: `Entity ${this.__DOCUMENT_NAME__}: not found` });
      }
      this.__DATA__ = { ...(row || {}), ...(this.__DATA__ || {}) };
      this.__IS_NEW__ = false;
    }
    await super.__init__();
  }

  static #allowed() {
    return loopar.currentUser?.user_type !== 'Web';
  }

  static #entityRows(mode) {
    return Object.values(loopar.getRefs() || {})
      .filter((ref) => {
        if (mode === 'all') return true;
        if (mode === 'child') return !!ref.is_child;
        return !ref.is_single && !ref.is_child;
      })
      .map((ref) => ({
        name: ref.__NAME__,
        label: ref.__NAME__,
        type: ref.__ENTITY__ || 'Entity',
        app: ref.__APP__ || '',
      }));
  }

  static #fieldRows(entity, kinds = 'discrete') {
    const ref = entity ? loopar.getRef(entity, false) : null;
    if (!ref) return [];
    const wanted = ['all', 'scalar'].includes(kinds) ? null
      : kinds === 'discrete' || !kinds ? DISCRETE
        : new Set(String(kinds).split(',').map((k) => k.trim()).filter(Boolean));
    return Object.entries(ref.__FIELD_META__ || {})
      .filter(([, m]) => {
        if (kinds === 'scalar') return !NOT_SCALAR.has(m.element) && !m.multiple;
        if (!wanted) return m.element !== 'form_table';
        if (!wanted.has(m.element)) return false;
        return !(m.element === 'connection' && m.multiple);
      })
      .map(([name, m]) => ({ name, label: m.label || name, type: m.element, app: ref.__NAME__ }));
  }

  /** Rows for a search, the mode and entity read from filters and parent value. */
  static rows({ mode = 'records', entity = null, kinds = null, term = null, names = null } = {}) {
    if (!EntityDirectory.#allowed()) return [];
    let rows = mode === 'fields' ? EntityDirectory.#fieldRows(entity, kinds) : EntityDirectory.#entityRows(mode);
    if (names) {
      const set = new Set(names.map(String));
      rows = rows.filter((r) => set.has(r.name));
    }
    if (term) {
      const t = String(term).trim().toLowerCase();
      rows = rows.filter((r) => r.name.toLowerCase().includes(t) || String(r.label).toLowerCase().includes(t));
    }
    return rows.sort((a, b) => mode === 'fields'
      ? 0
      : (a.app.localeCompare(b.app) || a.name.localeCompare(b.name)));
  }

  static #options(filters, parentValue) {
    const f = parseFilters(filters);
    const mode = ['records', 'child', 'all', 'fields'].includes(f.mode) ? f.mode : 'records';
    const entity = mode === 'fields' ? (parentValue || f.entity || null) : null;
    return { mode, entity, kinds: f.kinds || null };
  }

  #term(q) {
    if (!q) return null;
    if (typeof q === 'string') return q;
    return q.q || q.name || null;
  }

  async getListToSelectElement(q = null, { page = 1, limit = PAGE_SIZE, filterValue = null, filters = null } = {}) {
    const opts = EntityDirectory.#options(filters, filterValue);
    const all = EntityDirectory.rows({ ...opts, term: this.#term(q) });
    const size = Math.min(100, Math.max(1, parseInt(limit, 10) || PAGE_SIZE));
    const pages = Math.max(1, Math.ceil(all.length / size));
    const current = Math.min(Math.max(1, parseInt(page, 10) || 1), pages);
    return {
      title_fields: opts.mode === 'fields' ? ['label', 'name'] : ['name'],
      rows: all.slice((current - 1) * size, current * size),
      pagination: { page: current, pages, total: all.length },
      creatable: false,
    };
  }

  /** In fields mode the value is a field of the parent entity; else an entity. */
  async linkExists(name, { parentValue = null, filters = null } = {}) {
    const opts = EntityDirectory.#options(filters, parentValue);
    if (opts.mode === 'fields') {
      return ['name', 'id'].includes(name) || !!findFieldMeta(opts.entity, name);
    }
    return !!loopar.getRef(name, false);
  }

  async titlesFor() {
    return null;
  }

  async getValueDescriptive(name) {
    return name;
  }

  async getList({ fields = null, q = null, rowsOnly = false } = {}) {
    const entityName = this.__ENTITY__.name;
    const all = EntityDirectory.rows({ mode: 'all', term: this.#term(q) });
    const totalRecords = all.length;
    const totalPages = Math.max(1, Math.ceil(totalRecords / PAGE_SIZE));
    const page = Math.min(loopar.getPage(entityName), totalPages);

    return Object.assign((rowsOnly ? {} : await this.__meta__()), {
      labels: this.getFieldListLabels(),
      fields: fields || this.getFieldListNames(),
      rows: all.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
      pagination: { page, pageSize: PAGE_SIZE, totalPages, totalRecords, sortBy: 'app', sortOrder: 'asc', __ENTITY__: entityName },
      q,
    });
  }

  async save() {
    loopar.throw({ code: 405, message: 'Entity Directory is read-only. Edit the entity instead.' });
  }

  async delete() {
    loopar.throw({ code: 405, message: 'Entity Directory is read-only. Edit the entity instead.' });
  }
}
