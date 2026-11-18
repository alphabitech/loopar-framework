'use strict';

import { BaseDocument, loopar } from 'loopar';

function slugify(input = '') {
  return String(input)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

export default class PortfolioProject extends BaseDocument {
  constructor(props) {
    super(props);
  }

  async beforeSave() {
    if ((!this.slug || !String(this.slug).trim()) && this.title) {
      this.slug = await this.#uniqueSlug(slugify(this.title));
    } else if (this.slug) {
      const normalized = slugify(this.slug);
      if (normalized !== this.slug) {
        this.slug = await this.#uniqueSlug(normalized);
      }
    }
  }

  async #uniqueSlug(base) {
    if (!base) return base;
    let candidate = base;
    let i = 2;
    while (await this.#slugTaken(candidate)) {
      candidate = `${base}-${i++}`;
      if (i > 999) break;
    }
    return candidate;
  }

  async #slugTaken(slug) {
    const rows = await loopar.db.getList('Portfolio Project', {
      fields: ['name', 'slug'],
      filters: [['slug', '=', slug]]
    });
    if (!rows || rows.length === 0) return false;
    return rows.some(r => r.name !== this.name);
  }
}
