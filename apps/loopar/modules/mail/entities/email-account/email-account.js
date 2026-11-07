'use strict';

import { BaseDocument, loopar } from 'loopar';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * A sender for one website of a multi-site tenant. Mail sent while serving
 * that site's domain (contact forms, password recovery of its web users...)
 * goes out through this account, so alfra.dev mails come from @alfra.dev.
 * Anything else keeps using Email Settings, which also lends its SMTP server
 * when the account leaves it empty.
 */
export default class EmailAccount extends BaseDocument {
  constructor(props) {
    super(props);
  }

  async beforeSave() {
    this.name = String(this.name || '').trim().toLowerCase();
    if (!EMAIL_RE.test(this.name)) loopar.throw('Sender email must be a valid email address.');
    for (const f of ['notification_email', 'reply_to']) {
      this[f] = String(this[f] || '').trim();
      if (this[f] && !EMAIL_RE.test(this[f])) loopar.throw(`${f === 'reply_to' ? 'Reply-to' : 'Notification email'} must be a valid email address.`);
    }

    if ([1, '1', true].includes(this.enabled)) {
      const others = await loopar.db.getAll('Email Account', ['name'], { web_app: this.web_app, enabled: 1 });
      const taken = others.find((o) => o.name !== this.name);
      if (taken) loopar.throw(`${this.web_app} already sends through ${taken.name}. Disable that account first.`);
    }
  }

  async afterSave() {
    loopar.mail.reset();
  }

  async afterDelete() {
    loopar.mail.reset();
  }
}
