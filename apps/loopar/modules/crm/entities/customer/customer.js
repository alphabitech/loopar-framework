'use strict';

import { BaseDocument, loopar } from 'loopar';

const rowsOf = (value) => (loopar.utils.isJSON(value) ? JSON.parse(value) : Array.isArray(value) ? value : null);

/**
 * Customer: the account (a person or a company) every app associates its
 * records with. App-specific data lives in each app's own entity, linked
 * through a `customer` field; the people of the customer are its contacts.
 */
export default class Customer extends BaseDocument {
  constructor(props) {
    super(props);
  }

  async beforeSave() {
    this.customer_name = String(this.customer_name || '').trim().replace(/\s+/g, ' ');
    this.email = String(this.email || '').trim().toLowerCase() || null;
    this.customer_type ||= 'Individual';
    this.status ||= 'Active';

    const rows = rowsOf(this.contacts);
    if (!rows) return;

    const seen = new Set();
    for (const row of rows) {
      if (!row?.contact) continue;
      if (seen.has(row.contact)) loopar.throw(`Contact ${row.contact} is listed twice.`);
      seen.add(row.contact);
    }

    // One primary contact at most; the first one when several are marked.
    let primary = false;
    for (const row of rows) {
      const marked = loopar.utils.trueValue(row?.is_primary);
      row.is_primary = marked && !primary ? 1 : 0;
      primary ||= marked;
    }
    if (!primary && rows.length) rows[0].is_primary = 1;
    this.contacts = rows;
  }
}
