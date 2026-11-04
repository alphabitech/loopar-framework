'use strict';

import { Op } from "db-env";
import { loopar } from "loopar";
import { getRequest } from "../server/router/request-context.js";

/*
 * Portal identity and the 'customer' permission scope.
 *
 * A Web user reaches customer data through ONE explicit chain, made by staff:
 *
 *   User ──(Customer Contact.user)──▶ Customer Contact ──(Customer.contacts)──▶ Customer(s)
 *
 * Every app that serves a portal resolves "who is this customer" here, never
 * by matching emails and never from a name sent by the client. Records an app
 * exposes to customers carry a `customer` column (link to Customer); a grant
 * with scope 'customer' narrows them to the identity's customers.
 */

export const CUSTOMER_ENTITY = "Customer";
export const CONTACT_ENTITY = "Customer Contact";
export const CONTACT_LINK_ENTITY = "Customer Contact Link";
export const CUSTOMER_FIELD = "customer";

const NOBODY = "__nobody__";
const CACHE_KEY = "__PORTAL_IDENTITY__";

const EMPTY = (user) => Object.freeze({ user: user ?? null, contact: null, customers: Object.freeze([]) });

async function loadIdentity(user) {
  if (!user || !loopar.getRef(CONTACT_ENTITY, false)) return EMPTY(user);

  const contact = await loopar.db.getRow(CONTACT_ENTITY, { user }, ["name"]);
  if (!contact) return EMPTY(user);

  const links = await loopar.db.getAll(CONTACT_LINK_ENTITY, ["parent_id"], {
    contact: contact.name,
    parent_document: CUSTOMER_ENTITY,
  });
  const ids = [...new Set(links.map((l) => l.parent_id).filter((id) => id != null))];
  const customers = ids.length
    ? (await loopar.db.getAll(CUSTOMER_ENTITY, ["name"], { id: { [Op.in]: ids } })).map((c) => c.name)
    : [];

  return Object.freeze({ user, contact: contact.name, customers: Object.freeze(customers) });
}

/**
 * Identity of `user` (the logged-in user by default):
 * `{ user, contact, customers }` — contact is null and customers empty when
 * the user is not linked. Cached for the rest of the request.
 */
export async function portalIdentity(user = loopar.auth.user()) {
  const req = getRequest();
  const cache = req ? (req[CACHE_KEY] ??= new Map()) : null;
  if (cache?.has(user)) return cache.get(user);
  const identity = await loadIdentity(user);
  cache?.set(user, identity);
  return identity;
}

/** Drops the cached identity of this request (after linking/unlinking a contact). */
export function forgetPortalIdentity() {
  const req = getRequest();
  if (req) delete req[CACHE_KEY];
}

/**
 * Identity of the logged-in user, or a user-facing error when nobody is
 * signed in (401) or the user is not linked to any customer (403).
 */
export async function requirePortalIdentity({ message } = {}) {
  const user = loopar.auth.user();
  if (!user) loopar.throw({ code: 401, message: "Sign in to see your account." });
  const identity = await portalIdentity(user);
  if (!identity.customers.length) {
    loopar.throw({
      code: 403,
      message: message || "Your user is not linked to a customer account yet. Please contact us to get access.",
    });
  }
  return identity;
}

/**
 * Column of `entity` that holds the customer. Customer itself is matched by
 * name; any other entity by `field` (default `customer`).
 */
export function customerFieldOf(entity, field = CUSTOMER_FIELD) {
  return entity === CUSTOMER_ENTITY ? "name" : field;
}

/** Filter that narrows `entity` to the records of `identity`. */
export function customerCondition(entity, identity, field = CUSTOMER_FIELD) {
  if (entity === CONTACT_ENTITY) return { name: identity?.contact ?? NOBODY };
  const customers = identity?.customers ?? [];
  return { [customerFieldOf(entity, field)]: customers.length ? { [Op.in]: [...customers] } : NOBODY };
}

/**
 * Does record `name` of `entity` belong to `identity`?
 * Null when the record doesn't exist (the action 404s as usual).
 */
export async function isCustomerRecord(entity, name, identity, field = CUSTOMER_FIELD) {
  if (entity === CONTACT_ENTITY) {
    const row = await loopar.db.getRow(entity, name, ["name"]);
    return row ? row.name === identity?.contact : null;
  }
  const column = customerFieldOf(entity, field);
  const row = await loopar.db.getRow(entity, name, [column === "name" ? "name" : column]);
  if (!row) return null;
  const value = row[column];
  return value != null && (identity?.customers ?? []).includes(value);
}
