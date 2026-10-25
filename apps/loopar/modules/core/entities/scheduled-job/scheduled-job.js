'use strict';

import { BaseDocument } from 'loopar';

/** One scheduled job of one app in this tenant; rows are created by core/global/scheduler.js. */
export default class ScheduledJob extends BaseDocument {
  constructor(props) {
    super(props);
  }
}
