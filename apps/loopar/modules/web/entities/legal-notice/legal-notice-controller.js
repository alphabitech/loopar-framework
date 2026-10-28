'use strict';

import { BaseController, loopar } from 'loopar';

const PUBLIC_FIELDS = ['name', 'title', 'slug', 'app', 'effective_date', 'last_updated', 'summary'];

const appOf = (provided) => (provided && String(provided).trim()) || loopar.webApp?.name || null;

export default class LegalNoticeController extends BaseController {
  constructor(props) {
    super(props);
  }

  async publicActionPublicList() {
    const app = appOf(this.query?.app);
    if (!app) return { items: [], total: 0, page: 1, page_size: 0, total_pages: 1 };

    const items = await loopar.db.qx()('Legal Notice')
      .select(PUBLIC_FIELDS)
      .where({ app, published: 1 })
      .whereNull('__deleted_at__')
      .orderBy('title');

    return { items, total: items.length, page: 1, page_size: items.length, total_pages: 1 };
  }

  async publicActionPublicView() {
    const slug = this.query?.slug ? String(this.query.slug).trim() : null;
    const app = appOf(this.query?.app);
    if (!slug || !app) return null;

    return await loopar.db.qx()('Legal Notice')
      .select([...PUBLIC_FIELDS, 'description'])
      .where({ slug, app, published: 1 })
      .whereNull('__deleted_at__')
      .first() || null;
  }
}
