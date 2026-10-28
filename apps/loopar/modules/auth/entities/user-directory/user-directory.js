'use strict';

import { BaseDocument, loopar } from 'loopar';

const PAGE_SIZE = 20;

/**
 * Read-only directory of the desk (System) users: name and full name only.
 * Selects that pick a person (owner, interviewer…) link here instead of to
 * User, so roles can choose a teammate without being granted the User entity
 * (emails, roles, account settings). Disabled and Web (portal) users are left
 * out. Values stored by the selects are User names.
 */
export default class UserDirectory extends BaseDocument {
  constructor(props) {
    super(props);
  }

  async __init__(ifNotFound) {
    if (this.__DOCUMENT_NAME__) {
      const [row] = await UserDirectory.rows({ names: [this.__DOCUMENT_NAME__] });
      if (!row && ifNotFound === 'throw') {
        loopar.throw({ code: 404, message: `User ${this.__DOCUMENT_NAME__}: not found` });
      }
      this.__DATA__ = { ...(row || {}), ...(this.__DATA__ || {}) };
      this.__IS_NEW__ = false;
    }
    await super.__init__();
  }

  /** Web (portal) accounts never see the staff directory. */
  static #allowed() {
    return loopar.currentUser?.user_type !== 'Web';
  }

  static #query({ term = null, names = null } = {}) {
    const qb = loopar.db.qx()('User')
      .where((b) => b.whereNull('disabled').orWhere('disabled', 0))
      .where((b) => b.whereNull('user_type').orWhereNot('user_type', 'Web'))
      .whereNull('__deleted_at__');
    if (names) qb.whereIn('name', names);
    if (term) {
      const like = `%${String(term).trim()}%`;
      qb.where((b) => b.where('name', 'like', like).orWhere('first_name', 'like', like).orWhere('last_name', 'like', like));
    }
    return qb;
  }

  static #shape(r) {
    const full = [r.first_name, r.last_name].filter(Boolean).join(' ').trim();
    return { name: r.name, full_name: full || r.name };
  }

  static async rows({ term = null, names = null, limit = null, offset = 0 } = {}) {
    if (!UserDirectory.#allowed()) return [];
    const qb = UserDirectory.#query({ term, names }).select(['name', 'first_name', 'last_name']).orderBy('name');
    if (limit) qb.limit(limit).offset(offset);
    return (await qb).map(UserDirectory.#shape);
  }

  static async count(term = null) {
    if (!UserDirectory.#allowed()) return 0;
    const row = await UserDirectory.#query({ term }).count({ c: 'name' }).first();
    return Number(row?.c || 0);
  }

  #term(q) {
    if (!q) return null;
    if (typeof q === 'string') return q;
    return q.q || q.full_name || q.name || null;
  }

  async getListToSelectElement(q = null) {
    return {
      title_fields: this.getFieldSelectLabels(),
      rows: await UserDirectory.rows({ term: this.#term(q), limit: PAGE_SIZE }),
    };
  }

  async linkExists(name) {
    // Not filtered by the viewer: a stored teammate stays valid for a Web
    // user's save too; disabled users keep validating on old records.
    const row = await loopar.db.qx()('User').where({ name }).whereNull('__deleted_at__').first('name');
    return !!row;
  }

  /** Titles of stored values: disabled users included, so old records keep the name. */
  async titlesFor(names) {
    const rows = await loopar.db.qx()('User').whereIn('name', [...names]).select(['name', 'first_name', 'last_name']);
    return Object.fromEntries(rows.map(UserDirectory.#shape).map((r) => [r.name, r.full_name]));
  }

  async getValueDescriptive(name) {
    const [row] = await UserDirectory.rows({ names: [name] });
    return row?.full_name || name;
  }

  async getList({ fields = null, q = null, rowsOnly = false } = {}) {
    const entityName = this.__ENTITY__.name;
    const term = this.#term(q);
    const totalRecords = await UserDirectory.count(term);
    const totalPages = Math.max(1, Math.ceil(totalRecords / PAGE_SIZE));
    const page = Math.min(loopar.getPage(entityName), totalPages);

    const rows = await UserDirectory.rows({ term, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });

    return Object.assign((rowsOnly ? {} : await this.__meta__()), {
      labels: this.getFieldListLabels(),
      fields: fields || this.getFieldListNames(),
      rows,
      pagination: { page, pageSize: PAGE_SIZE, totalPages, totalRecords, sortBy: 'name', sortOrder: 'asc', __ENTITY__: entityName },
      q,
    });
  }

  async save() {
    loopar.throw({ code: 405, message: 'User Directory is read-only. Edit the user instead.' });
  }

  async delete() {
    loopar.throw({ code: 405, message: 'User Directory is read-only. Edit the user instead.' });
  }
}
