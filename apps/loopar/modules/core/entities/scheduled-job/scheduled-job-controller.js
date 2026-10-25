'use strict';

import { BaseController, loopar } from 'loopar';
import { scheduler } from 'loopar/core/global/scheduler.js';

export default class ScheduledJobController extends BaseController {
  constructor(props) {
    super(props);
  }

  /**
   * Runs the job now, in this tenant. Data endpoint: `{ job_status, result }`
   * (`status`/`message` are reserved by the response envelope).
   */
  async actionRunNow() {
    if (!this.query?.name) loopar.throw('Missing job.');
    const { status, result } = await scheduler.runNow(this.query.name);
    return { job_status: status, result };
  }
}
