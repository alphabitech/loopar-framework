
'use strict';

import {BaseController, loopar} from 'loopar';

export default class EmailSettingsController extends BaseController {
    constructor(props){
        super(props);
    }

    async actionTestConnection(){
      const data = this.query;
      if(data.password == "********"){
        // Stored encrypted: read through the document so it gets decrypted.
        data.password = (await loopar.getDocument("Email Settings")).password;
      }
      const test = await loopar.mail.testConnection(data);
      if (!test.success) {
        // SMTP server rejected/unreachable: upstream failure, not a request bug.
        loopar.throw({ status: 502, code: 'SMTP_CONNECTION_FAILED', title: 'Connection failed', message: test.error });
      }
      return await this.success('Connection successful');
    }

    /** Sends a real message to the notification address using the form's values. */
    async actionSendTestEmail(){
      const data = this.query;
      if(data.password == "********"){
        data.password = (await loopar.getDocument("Email Settings")).password;
      }
      const to = String(data.notification_email || '').trim();
      if (!data.from_email) loopar.throw({ status: 400, code: 'SENDER_REQUIRED', title: 'Sender missing', message: 'Set the Sender Email first.' });
      if (!to) loopar.throw({ status: 400, code: 'RECIPIENT_REQUIRED', title: 'Recipient missing', message: 'Set the Notification Email first: the test is sent there.' });

      const test = await loopar.mail.sendTest(data, to);
      if (!test.success) {
        loopar.throw({ status: 502, code: 'SMTP_SEND_FAILED', title: 'Test email not sent', message: test.error });
      }
      return await this.success(`Test email sent to ${to}`);
    }
}