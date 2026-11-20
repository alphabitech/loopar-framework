'use strict';

import { BaseDocument } from 'loopar';

/**
 * Pages one user pinned to the desk shortcuts menu (top bar grid). One record
 * per user, written by the menu through DeskPinController.actionSave; see
 * core/document/desk-pins.js.
 */
export default class DeskPin extends BaseDocument {
  constructor(props) {
    super(props);
  }
}
