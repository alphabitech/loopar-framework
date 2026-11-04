'use strict';

import { BaseDocument } from 'loopar';

/** Id of a Customer in another system (child row of Customer.external_ids). */
export default class CustomerExternalId extends BaseDocument {
  constructor(props) {
    super(props);
  }

  async beforeSave() {
    this.source = String(this.source || '').trim().toLowerCase();
    this.external_id = String(this.external_id || '').trim();
  }
}
