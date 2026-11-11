'use strict';

import { BaseDocument, loopar } from 'loopar';
import { keyMode, ENTITY } from '../../stripe-accounts.js';

/**
 * One set of Stripe credentials. The mode is never chosen by hand: it is the
 * mode of the Secret Key, so a record can't say "test" while it charges live
 * cards. There is one account per mode at most, and exactly one of them is
 * the Billing account: the one the site charges with.
 */
export default class StripeAccount extends BaseDocument {
  constructor(props) {
    super(props);
  }

  async #others() {
    return (await loopar.db.getAll(ENTITY, ['name', 'mode', 'billing'])).filter(row => row.name !== this.name);
  }

  async save() {
    // A password field left untouched arrives empty or masked: only a value
    // that is a Stripe key says something about the mode.
    const secretMode = keyMode(this.secret_key);
    if (secretMode) this.mode = secretMode;
    const mode = this.mode === 'live' ? 'live' : this.mode === 'test' ? 'test' : null;

    if (!mode) {
      loopar.throw('Enter the Secret Key of this account (sk_live_… or sk_test_…): it decides the mode.');
    }

    const publishable = keyMode(this.publishable_key);
    if (publishable && publishable !== mode) {
      loopar.throw(`The Publishable Key is a ${publishable} key but the Secret Key is ${mode}: both must be of the same Stripe mode.`);
    }

    const others = await this.#others();
    const sameMode = others.find(row => row.mode === mode);
    if (sameMode) {
      loopar.throw(`"${sameMode.name}" is already the ${mode} account: there is one account per mode.`);
    }

    // The first account bills; after that, marking one moves the mark.
    const billingElsewhere = others.some(row => loopar.utils.trueValue(row.billing));
    if (!billingElsewhere) this.billing = 1;

    const result = await super.save(...arguments);

    if (loopar.utils.trueValue(this.billing)) {
      for (const row of others.filter(row => loopar.utils.trueValue(row.billing))) {
        await loopar.db.qx()(ENTITY).where({ name: row.name }).update({ billing: 0 });
      }
    }

    return result;
  }

  async delete() {
    if (loopar.utils.trueValue(this.billing) && (await this.#others()).length) {
      loopar.throw('This is the Billing account: mark another account as Billing before deleting it.');
    }
    return await super.delete(...arguments);
  }
}
