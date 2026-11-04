'use strict';

import { BaseDocument } from 'loopar';
import { pageData } from '../../backup-page-data.js';

/** The Backups page: list, create, download, upload and restore this site's backups. */
export default class Backups extends BaseDocument {
  constructor(props) {
    super(props);
  }

  async __meta__() {
    return { ...await super.__meta__(), data: await pageData({ remote: false }) };
  }
}
