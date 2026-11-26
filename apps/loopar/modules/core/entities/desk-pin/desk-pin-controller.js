'use strict';

import { BaseController, writeDeskPins } from 'loopar';
import WorkspaceController from 'loopar/core/controller/workspace-controller.js';

export default class DeskPinController extends BaseController {
  // Any signed-in user saves their own pins; nobody else's can be reached.
  // `destinations` only lists what that user may open.
  static freeActions = ['save', 'destinations'];

  /** Body: `{ pins: [{ link, label, icon }] }`. Replaces the current user's pins. */
  /** Every desk destination the user can reach: feeds the shortcuts menu and the command palette. */
  async actionDestinations() {
    return { search_index: await WorkspaceController.searchIndex() };
  }

  async actionSave() {
    return { saved: true, pins: await writeDeskPins(this.data?.pins) };
  }
}
