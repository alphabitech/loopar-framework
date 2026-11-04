'use strict';

import { BaseDocument } from 'loopar';
import StripeClass from 'stripe';

export default class Stripe extends BaseDocument {
  constructor(props) {
    super(props);
  }

  get Stripe() {
    return new StripeClass(this.secret_key);
  }

  async onLoad() {
    await super.onLoad();
    //this.stripe = new StripeClass(this.secret_key);
  }

  async authorize() {
    return {
      client_secret: await this.clientSecret(),
      publishable_key: this.public_key,
    }
  }

  async clientSecret() {
    const paymentIntent = await this.Stripe.paymentIntents.create({
      amount: 5,
      currency: 'usd'
    });

    console.log({ paymentIntent });

    return paymentIntent.client_secret;
  }
}