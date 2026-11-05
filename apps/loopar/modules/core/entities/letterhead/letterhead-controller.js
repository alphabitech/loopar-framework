'use strict';

import { BaseController, getLetterhead } from 'loopar';

export default class LetterheadController extends BaseController {
  // Company identity + letterhead, not a secret: any signed-in desk user may read the default
  // one (print views outside the print entry, e.g. a form preview).
  static freeActions = ["current"];

  constructor(props) {
    super(props);
  }

  async actionCurrent() {
    return { letterhead: await getLetterhead(this.query?.name || null) };
  }
}
