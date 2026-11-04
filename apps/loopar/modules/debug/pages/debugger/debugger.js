'use strict';

import { BaseDocument, loopar, debugCollector, frameworkStatus, testsAllowed } from 'loopar';

/**
 * The Debugger page: Yii-debug style view of what the framework did for this
 * tenant — requests, SQL, logs, errors, status — plus test runs and API
 * tokens. The data lives in core/debug (collector, status, test runner);
 * this document only bundles the first screen.
 */
export default class Debugger extends BaseDocument {
  constructor(props) {
    super(props);
  }

  async data() {
    const tenant = loopar.requestTenantId;
    return {
      enabled: debugCollector.enabled,
      testsAllowed: testsAllowed(),
      status: await frameworkStatus(),
      requests: debugCollector.requests(tenant, { limit: 50 }),
    };
  }

  async __meta__() {
    return { ...await super.__meta__(), data: await this.data() };
  }
}
