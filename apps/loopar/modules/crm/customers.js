'use strict';

/*
 * Customer helpers for apps. Customer only holds what every app shares
 * (name, type, email, phone, address); each app keeps its own data in its
 * own entity linked through a `customer` field, and integrations keep their
 * ids in Customer.external_ids.
 *
 * Customer saves pass `forceChildren`: during an app install the core skips
 * child tables otherwise, and migrations call these helpers.
 */

import { loopar, Op } from 'loopar';
import { ensureCustomerContact } from './portal-access.js';

const CUSTOMER = 'Customer';
const EXTERNAL = 'Customer External ID';

/** Shared fields an app may set on a Customer. */
export const CUSTOMER_FIELDS = ['customer_name', 'customer_type', 'status', 'email', 'phone', 'address', 'city', 'state', 'zip_code', 'country', 'notes'];

const pick = (data) => Object.fromEntries(CUSTOMER_FIELDS.filter((f) => data[f] !== undefined).map((f) => [f, data[f]]));

/**
 * Creates a Customer from `data` (CUSTOMER_FIELDS) and, when it has an
 * email, its primary contact (`contact_name` overrides the contact's name).
 * Returns the customer name.
 */
export async function createCustomer(data = {}) {
  const doc = await loopar.newDocument(CUSTOMER);
  Object.assign(doc, pick(data));
  await doc.save({ forceChildren: true });
  if (data.email) {
    await ensureCustomerContact(doc.name, { email: data.email, full_name: data.contact_name || data.customer_name, phone: data.phone ?? null });
  }
  return doc.name;
}

/** Updates the shared fields of a Customer (only the ones given). */
export async function updateCustomer(name, data = {}) {
  const values = pick(data);
  if (!Object.keys(values).length) return;
  const doc = await loopar.getDocument(CUSTOMER, name);
  Object.assign(doc, values);
  await doc.save({ forceChildren: true });
}

/** Shared fields of the customers `names`, as a Map name → row. */
export async function customersByName(names, fields = ['customer_name', 'email', 'phone']) {
  const list = [...new Set((names || []).filter(Boolean))];
  if (!list.length) return new Map();
  const rows = await loopar.db.getAll(CUSTOMER, ['name', ...fields], { name: { [Op.in]: list } });
  return new Map(rows.map((r) => [r.name, r]));
}

/** Shared fields of one customer, or null. */
export async function customerRow(name, fields = ['customer_name', 'email', 'phone']) {
  if (!name) return null;
  return await loopar.db.getRow(CUSTOMER, name, ['name', ...fields]);
}

/* ------------------------------------------------------------------ */
/* External ids                                                        */
/* ------------------------------------------------------------------ */

const norm = (s) => String(s || '').trim().toLowerCase();

/** Id of `customerName` in system `source`, or null. */
export async function externalId(customerName, source) {
  const customer = await loopar.db.getRow(CUSTOMER, customerName, ['id']);
  if (!customer) return null;
  const row = await loopar.db.getRow(EXTERNAL, { parent_id: customer.id, parent_document: CUSTOMER, source: norm(source) }, ['external_id']);
  return row?.external_id || null;
}

/** Customer whose id in system `source` is `id`, or null. */
export async function customerByExternalId(source, id) {
  if (!id) return null;
  const row = await loopar.db.getRow(EXTERNAL, { parent_document: CUSTOMER, source: norm(source), external_id: String(id) }, ['parent_id']);
  if (!row) return null;
  return (await loopar.db.getRow(CUSTOMER, { id: row.parent_id }, ['name']))?.name ?? null;
}

/** Stores (or replaces) the id of `customerName` in system `source`. */
export async function setExternalId(customerName, source, id) {
  const doc = await loopar.getDocument(CUSTOMER, customerName);
  const customer = await loopar.db.getRow(CUSTOMER, customerName, ['id']);
  const rows = await loopar.db.getAll(EXTERNAL, ['name', 'source', 'external_id'], { parent_id: customer.id, parent_document: CUSTOMER });
  const key = norm(source);
  const current = rows.find((r) => r.source === key);
  if (current?.external_id === String(id)) return;
  doc.external_ids = current
    ? rows.map((r) => (r.name === current.name ? { ...r, external_id: String(id) } : r))
    : [...rows, { source: key, external_id: String(id) }];
  await doc.save({ forceChildren: true });
}
