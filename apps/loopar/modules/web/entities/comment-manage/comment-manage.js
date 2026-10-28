'use strict';

import { BaseDocument, loopar } from 'loopar';

const COMMENT_TABLE = 'Comment';
const PAGE_SIZE = 10;

export default class CommentManage extends BaseDocument {
  constructor(props) {
    super(props);
  }

  #applyScope(qb, q) {
    const term = q && (q.q || q.comment || q.document_name || q.author || q.name);
    if (term) {
      const like = `%${String(term).trim()}%`;
      qb.where((b) => {
        b.where('comment', 'like', like)
          .orWhere('document_name', 'like', like)
          .orWhere('document', 'like', like)
          .orWhere('user', 'like', like)
          .orWhere('guest_name', 'like', like);
      });
    }
    return qb;
  }

  async getList({ fields = null, q = null, rowsOnly = false } = {}) {
    const entityName = this.__ENTITY__.name;
    const page = loopar.getPage(entityName);

    const totalRow = await this.#applyScope(loopar.db.qx()(COMMENT_TABLE), q)
      .count({ count: 'id' })
      .first();
    const totalRecords = Number(totalRow?.count || 0);
    const totalPages = Math.max(1, Math.ceil(totalRecords / PAGE_SIZE));

    const safePage = Math.min(page, totalPages);

    const raw = await this.#applyScope(loopar.db.qx()(COMMENT_TABLE), q)
      .select(['name', 'user', 'guest_name', 'comment', 'document', 'document_name', 'parent', 'status', 'created_at'])
      .orderBy('created_at', 'desc')
      .limit(PAGE_SIZE)
      .offset((safePage - 1) * PAGE_SIZE);

    const rows = raw.map((r) => ({
      name: r.name,
      author: r.user || r.guest_name || 'Guest',
      comment: r.comment,
      document: r.document,
      document_name: r.document_name,
      parent: r.parent || null,
      event_at: r.created_at,
      status: r.status,
    }));

    const pagination = {
      page: safePage,
      pageSize: PAGE_SIZE,
      totalPages,
      totalRecords,
      sortBy: 'created_at',
      sortOrder: 'desc',
      __ENTITY__: entityName,
    };

    return Object.assign((rowsOnly ? {} : await this.__meta__()), {
      labels: this.getFieldListLabels(),
      fields: fields || this.getFieldListNames(),
      rows,
      pagination,
      q,
    });
  }
}