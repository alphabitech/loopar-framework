'use strict';

import { CoreInstaller } from 'loopar';
import { cloneRepo } from './git-actions.js';

export default class AppManager extends CoreInstaller {
  /** Get App: clones with the user's Git Account so private repos work on servers too. */
  async clone() {
    return await super.clone(this.git_repo, cloneRepo);
  }
}
