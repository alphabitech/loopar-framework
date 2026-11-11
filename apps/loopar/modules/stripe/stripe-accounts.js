'use strict';

/**
 * Stripe accounts of this site: one record per Stripe mode (Stripe Account),
 * one of them marked as Billing. Everything that talks to Stripe gets its
 * key from here.
 */

import { loopar } from 'loopar';
import Stripe from 'stripe';

export const ENTITY = 'Stripe Account';

/**
 * In Stripe the key decides the mode: sk_live_… / sk_test_… (secret),
 * rk_… (restricted), pk_… (publishable). 'live' | 'test', or null when the
 * value is not a Stripe key (empty, masked, encrypted at rest…).
 */
export function keyMode(key) {
  const m = /^(?:sk|rk|pk)_(live|test)_/.exec(String(key || '').trim());
  return m ? m[1] : null;
}

const rows = async () => await loopar.db.getAll(ENTITY, ['name', 'mode', 'billing']);

/** The document (secrets readable server side) of the row `pick` selects, or null. */
async function accountWhere(pick) {
  const row = (await rows()).find(pick);
  return row ? await loopar.getDocument(ENTITY, row.name, null, { ifNotFound: null }) : null;
}

/** The account this site charges with, or null when Stripe is not set up. */
export async function billingAccount() {
  return await accountWhere(row => loopar.utils.trueValue(row.billing));
}

/** The account of a Stripe mode ('live' | 'test'), or null. */
export async function accountOf(mode) {
  return await accountWhere(row => row.mode === mode);
}

/** The mode billing runs in ('live' | 'test'); 'test' while nothing is set up. */
export async function stripeMode() {
  return (await rows()).find(row => loopar.utils.trueValue(row.billing))?.mode === 'live' ? 'live' : 'test';
}

/** Stripe client of the Billing account, or null when it has no Secret Key. */
export async function stripeClient() {
  const account = await billingAccount();
  return account?.secret_key ? new Stripe(account.secret_key) : null;
}

/** Stripe client of a given mode, or null when no account of that mode exists. */
export async function stripeClientFor(mode) {
  const account = await accountOf(mode);
  const key = account?.secret_key;
  // Never hand out a client of another mode than the one asked for.
  if (!key || (keyMode(key) && keyMode(key) !== mode)) return null;
  return new Stripe(key);
}

/**
 * Verifies a webhook delivery against the signing secret of each account.
 * Returns { event, account, billing } for the account that signed it, or
 * null when no account did. An event of an account that is not the Billing
 * one is authentic but not ours to process (e.g. test deliveries on a live site).
 */
export async function verifyWebhook(rawBody, signature) {
  const list = await rows();
  // Billing first: it is the one that signs nearly every delivery.
  list.sort((a, b) => Number(loopar.utils.trueValue(b.billing)) - Number(loopar.utils.trueValue(a.billing)));

  for (const row of list) {
    const account = await loopar.getDocument(ENTITY, row.name, null, { ifNotFound: null });
    if (!account?.secret_key || !account?.webhook_secret) continue;
    try {
      const event = new Stripe(account.secret_key).webhooks.constructEvent(rawBody, signature, account.webhook_secret);
      return { event, account, billing: !!loopar.utils.trueValue(row.billing) };
    } catch {
      // Not signed by this account: try the next one.
    }
  }
  return null;
}
