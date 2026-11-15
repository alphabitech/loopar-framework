'use strict';

import { BaseDocument } from 'loopar';

/**
 * One user's settings for the list of one entity (column order, hidden and
 * extra columns, widths, sort). Written by the list itself through
 * ListViewSettingController.actionSave; see core/global/list-settings.js.
 */
export default class ListViewSetting extends BaseDocument {
  constructor(props) {
    super(props);
  }
}
