'use strict';

import { BaseDocument, loopar } from 'loopar';

/** Tagline and footer printed with the Company identity. One can be the default (see print formats). */
export default class Letterhead extends BaseDocument {
  constructor(props) {
    super(props);
  }

  async save() {
    await super.save(...arguments);

    // Only one default: marking this one unmarks the rest.
    if (loopar.utils.trueValue(this.is_default)) {
      const others = await loopar.db.getAll("Letterhead", ["name"], { is_default: 1 });
      for (const row of others) {
        if (row.name !== this.name) await loopar.db.setValue("Letterhead", "is_default", 0, row.name);
      }
    }
  }
}
