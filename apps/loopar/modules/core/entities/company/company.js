'use strict';

import { BaseDocument, loopar } from 'loopar';
import { usesCompanyBrand } from '../system-settings/theme-css.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TEXT_FIELDS = ['company_name', 'legal_name', 'tax_id_label', 'tax_id', 'email', 'phone', 'website', 'city', 'state', 'postal_code'];

/**
 * The tenant's company: identity, contact, address, brand and regional
 * defaults. One per tenant (single). Read it with `getCompany()` from loopar.
 */
export default class Company extends BaseDocument {
  constructor(props) {
    super(props);
  }

  async validate() {
    for (const f of TEXT_FIELDS) this[f] = String(this[f] ?? '').trim();
    this.email = this.email.toLowerCase();
    if (this.email && !EMAIL_RE.test(this.email)) loopar.throw('The company email is not a valid email address.');
    if (this.website && !/^https?:\/\//i.test(this.website)) this.website = `https://${this.website}`;
    if (this.tax_id && !this.tax_id_label) this.tax_id_label = 'Tax ID';
    await super.validate();
  }

  async save() {
    await super.save(...arguments);
    await Company.refreshBrandThemes();
  }

  /** Rebuilds every theme that follows the Company brand (System Settings and web apps). */
  static async refreshBrandThemes() {
    try {
      const settings = await loopar.getDocument('System Settings', null, null, { ifNotFound: null });
      if (settings && usesCompanyBrand(settings.theme)) await settings.setTheme();

      for (const row of await loopar.db.getAll('App', ['name', 'theme'])) {
        if (!usesCompanyBrand(row.theme)) continue;
        const app = await loopar.getDocument('App', row.name);
        await app.writeTheme();
      }
    } catch (e) {
      console.warn('[company] themes not refreshed:', e?.message);
    }
  }
}
