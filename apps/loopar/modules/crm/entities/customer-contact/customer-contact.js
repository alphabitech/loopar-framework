'use strict';

import { BaseDocument, loopar } from 'loopar';
import { SYSTEM_WRITE } from '../../portal-access.js';

/**
 * A person of one or more customers. `user` is THE link between a Web user
 * and the customer data the portals show (auth/customer-scope.js), so it is
 * only written by the portal-access service, never from a form payload.
 */
export default class CustomerContact extends BaseDocument {
  constructor(props) {
    super(props);
  }

  async beforeSave() {
    this.full_name = String(this.full_name || '').trim().replace(/\s+/g, ' ');
    this.email = String(this.email || '').trim().toLowerCase() || null;
    this.phone = String(this.phone || '').trim() || null;

    if (!SYSTEM_WRITE.has(this)) {
      const stored = this.__IS_NEW__ ? null : await loopar.db.getRow('Customer Contact', this.__DOCUMENT_NAME__ || this.name, ['user']);
      this.user = stored?.user || null;
    }

    if (this.user) {
      const other = await loopar.db.getRow('Customer Contact', { user: this.user }, ['name']);
      if (other && other.name !== this.name) loopar.throw(`User ${this.user} is already the portal user of contact ${other.name}.`);
    }
  }
}
