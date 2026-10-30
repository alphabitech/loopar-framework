'use strict';

import { BaseDocument, loopar } from 'loopar';

const day = (v) => (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10);

/**
 * A short notice a website shows in a slim bar above its navigation, on every
 * page (an ownership statement, "We're hiring", a holiday closure…). The
 * active one of highest priority is shown; dates make it temporary.
 */
export default class Announcement extends BaseDocument {
  constructor(props) {
    super(props);
  }

  async validate() {
    await super.validate();
    if (this.starts_on && this.ends_on && day(this.ends_on) < day(this.starts_on)) {
      loopar.throw('The announcement ends before it starts.');
    }
  }
}
