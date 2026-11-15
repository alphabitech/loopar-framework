'use strict';

import { loopar, BaseController, writeListSettings } from 'loopar';

export default class ListViewSettingController extends BaseController {
  // Any signed-in user saves their own settings; nobody else's can be reached.
  static freeActions = ['save'];

  /** Body: `{ entity, settings }`. Replaces the current user's settings for that entity's list. */
  async actionSave() {
    const entity = String(this.data?.entity || '');
    if (!entity || !loopar.getRef(entity)) {
      loopar.throw({ code: 404, message: 'Unknown entity.' });
    }

    return { saved: true, settings: await writeListSettings(entity, this.data?.settings) };
  }
}
