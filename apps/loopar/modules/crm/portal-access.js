'use strict';

/*
 * Portal access for customer contacts — the only place that writes
 * `Customer Contact.user`. Apps call these instead of keeping their own
 * `portal_user` columns; what a portal user may see is then resolved by
 * `portalIdentity()` / scope 'customer' (core/auth/customer-scope.js).
 */

import crypto from 'node:crypto';
import { loopar, Op, forgetPortalIdentity, CHILD_POSITION_COLUMN } from 'loopar';

const CUSTOMER = 'Customer';
const CONTACT = 'Customer Contact';
const LINK = 'Customer Contact Link';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Documents saved by this service (their `user` is not reset by the model). */
export const SYSTEM_WRITE = new WeakSet();

const fail = (message, code = 400) => loopar.throw({ code, title: 'Portal access', message });

/** Temporary password a person can read and type (no 0/O, 1/l/I). */
export function readablePassword(length = 10) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  return Array.from(crypto.randomBytes(length), (b) => alphabet[b % alphabet.length]).join('');
}

const unknownPassword = () => `${crypto.randomBytes(18).toString('base64url')}aA1!`;

async function setContactUser(contactName, user) {
  const doc = await loopar.getDocument(CONTACT, contactName);
  doc.user = user;
  SYSTEM_WRITE.add(doc);
  await doc.save();
  forgetPortalIdentity();
}

/**
 * Gives contact `contactName` a Web user for the portals, creating it or
 * linking the existing Web user with the contact's email. Idempotent.
 *
 *   password: 'temporary' → a readable password is returned once, for staff
 *                           to hand over; the user must change it.
 *             'unknown'   → nobody knows it; the app signs the user in with
 *                           its own link (e.g. an emailed activation link).
 *
 * Returns { user, created, password } (password only when one was made).
 */
export async function grantPortalAccess(contactName, { password = 'temporary' } = {}) {
  const contact = await loopar.db.getRow(CONTACT, contactName, ['name', 'full_name', 'email', 'phone', 'user']);
  if (!contact) fail(`Contact ${contactName} does not exist.`, 404);

  if (contact.user && await loopar.db.getRow('User', contact.user, ['name'])) {
    return { user: contact.user, created: false, password: null };
  }

  const email = String(contact.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) fail('The contact needs a valid email to access the portal.');

  const existing = await loopar.db.getRow('User', { email }, ['name', 'user_type']);
  if (existing) {
    if (existing.user_type !== 'Web') fail('That email belongs to a system (desk) user. Use a different email for the contact.');
    const other = await loopar.db.getRow(CONTACT, { user: existing.name }, ['name']);
    if (other && other.name !== contact.name) fail(`That user is already linked to contact ${other.name}.`);
    await setContactUser(contact.name, existing.name);
    return { user: existing.name, created: false, password: null };
  }

  const secret = password === 'unknown' ? unknownPassword() : readablePassword();
  const [first, ...rest] = String(contact.full_name || '').split(' ');
  const user = await loopar.newDocument('User');
  user.name = email;
  user.email = email;
  user.first_name = first || email;
  user.last_name = rest.join(' ');
  if (contact.phone) user.phone = contact.phone;
  user.password = secret;
  user.confirm_password = secret;
  user.user_type = 'Web';
  user.must_change_password = 1;
  user.__document_status__ = 'Active';
  await user.save({ validate: false });

  await setContactUser(contact.name, user.name);
  return { user: user.name, created: true, password: password === 'unknown' ? null : secret };
}

/**
 * Links an existing Web user to a contact (data migrations, apps that create
 * the user themselves). Refuses a user that already belongs to another contact.
 */
export async function linkPortalUser(contactName, user) {
  const row = await loopar.db.getRow('User', user, ['name', 'user_type']);
  if (!row) fail(`User ${user} does not exist.`, 404);
  if (row.user_type !== 'Web') fail('Only Web users can be portal users.');
  const other = await loopar.db.getRow(CONTACT, { user }, ['name']);
  if (other && other.name !== contactName) fail(`That user is already linked to contact ${other.name}.`);
  if (!other) await setContactUser(contactName, user);
}

/** Removes the portal user of a contact (the Web user itself is kept). */
export async function revokePortalAccess(contactName) {
  const contact = await loopar.db.getRow(CONTACT, contactName, ['name', 'user']);
  if (!contact) fail(`Contact ${contactName} does not exist.`, 404);
  if (contact.user) await setContactUser(contact.name, null);
}

/** Contact rows of a customer, in the form's order: [{ name, contact, job_title, is_primary }]. */
async function linkRows(customerName) {
  const customer = await loopar.db.getRow(CUSTOMER, customerName, ['id']);
  if (!customer) return [];
  const rows = await loopar.db.getAll(LINK, ['name', 'contact', 'job_title', 'is_primary', CHILD_POSITION_COLUMN], { parent_id: customer.id, parent_document: CUSTOMER });
  return rows
    .sort((a, b) => (a[CHILD_POSITION_COLUMN] ?? 0) - (b[CHILD_POSITION_COLUMN] ?? 0))
    .map(({ [CHILD_POSITION_COLUMN]: _position, ...row }) => row);
}

/** Contacts of a customer: [{ contact, job_title, is_primary }], primary first. */
export async function customerContacts(customerName) {
  const rows = (await linkRows(customerName)).map(({ name: _name, ...row }) => row);
  return rows.sort((a, b) => Number(loopar.utils.trueValue(b.is_primary)) - Number(loopar.utils.trueValue(a.is_primary)));
}

/** Primary contact of a customer (name), or null. */
export async function primaryContact(customerName) {
  return (await customerContacts(customerName))[0]?.contact ?? null;
}

/**
 * Contact of `customerName` with `email`, created (and added to the
 * customer's contacts, primary when it is the first) when missing.
 * Returns the contact name.
 */
export async function ensureCustomerContact(customerName, { email, full_name, phone = null } = {}) {
  email = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) fail('A valid email is required for the contact.');

  const customer = await loopar.getDocument(CUSTOMER, customerName, null, { ifNotFound: null });
  if (!customer) fail(`Customer ${customerName} does not exist.`, 404);

  const links = await linkRows(customerName);
  if (links.length) {
    const mine = await loopar.db.getAll(CONTACT, ['name'], { email, name: { [Op.in]: links.map((l) => l.contact) } });
    if (mine.length) return mine[0].name;
  }

  let contactName = (await loopar.db.getRow(CONTACT, { email }, ['name']))?.name;
  if (!contactName) {
    const contact = await loopar.newDocument(CONTACT);
    contact.full_name = full_name || customer.customer_name || email;
    contact.email = email;
    contact.phone = phone;
    await contact.save();
    contactName = contact.name;
  }

  if (!links.some((l) => l.contact === contactName)) {
    customer.contacts = [...links, { contact: contactName, job_title: null, is_primary: links.length ? 0 : 1 }];
    await customer.save({ forceChildren: true });
    forgetPortalIdentity();
  }
  return contactName;
}
