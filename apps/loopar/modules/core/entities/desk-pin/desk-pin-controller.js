'use strict';

import { BaseController, writeDeskPins } from 'loopar';

export default class DeskPinController extends BaseController {
  // Any signed-in user saves their own pins; nobody else's can be reached.
  static freeActions = ['save'];

  /** Body: `{ pins: [{ link, label, icon }] }`. Replaces the current user's pins. */
  async actionSave() {
    return { saved: true, pins: await writeDeskPins(this.data?.pins) };
  }
}
