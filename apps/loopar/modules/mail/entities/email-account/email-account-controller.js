'use strict';

import { BaseController, loopar } from 'loopar';

export default class EmailAccountController extends BaseController {
  static postOnlyActions = ['testConnection'];

  constructor(props) {
    super(props);
  }

  /** Tests the form values (saved or not) merged over Email Settings' server. */
  async actionTestConnection() {
    const data = { ...this.query, ...this.data };
    data.name = String(data.name || '').trim().toLowerCase();
    if (!data.password || data.password === '********') {
      const saved = data.name && (await loopar.db.getAll('Email Account', ['name'], { name: data.name })).length;
      data.password = saved ? (await loopar.getDocument('Email Account', data.name)).password : '';
    }
    const settings = await loopar.mail.mergeAccount(data);
    if (!settings.host) loopar.throw('Set an SMTP host here or in Email Settings.');
    const test = await loopar.mail.testConnection(settings);
    if (!test.success) {
      loopar.throw({ status: 502, code: 'SMTP_CONNECTION_FAILED', title: 'Connection failed', message: test.error });
    }
    return await this.success(`Connection successful (${settings.user} @ ${settings.host})`);
  }
}
