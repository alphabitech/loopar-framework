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

const today = () => new Date().toISOString().slice(0, 10);

/**
 * A legal text a website publishes (Privacy Notice, Terms of Use…), written
 * by the site owner. Public at /legal/<slug> on the app's website; the slug
 * is unique per app, so every site can have its own "privacy-notice".
 */
export default class LegalNotice extends BaseDocument {
  constructor(props) {
    super(props);
  }

  async beforeSave() {
    const slug = slugify(this.slug || this.title);
    this.slug = slug === this.slug ? slug : await this.#uniqueSlug(slug);

    if (this.__IS_NEW__ || this.description !== (await this.#savedContent())) {
      this.last_updated = today();
    }
    if (Number(this.published) === 1 && !this.effective_date) {
      this.effective_date = today();
    }
  }

  async validate() {
    await super.validate();
    if (this.slug && await this.#slugTaken(this.slug)) {
      loopar.throw(`Another legal notice of ${this.app} already uses the address /legal/${this.slug}.`);
    }
  }

  async #savedContent() {
    return await loopar.db.getValue('Legal Notice', 'description', this.__DOCUMENT_NAME__);
  }

  async #uniqueSlug(base) {
    if (!base) return base;
    let candidate = base;
    for (let i = 2; await this.#slugTaken(candidate) && i < 1000; i++) {
      candidate = `${base}-${i}`;
    }
    return candidate;
  }

  async #slugTaken(slug) {
    const rows = await loopar.db.qx()('Legal Notice')
      .select(['name'])
      .where({ slug, app: this.app })
      .whereNull('__deleted_at__');
    return (rows || []).some(r => r.name !== this.name);
  }
}
