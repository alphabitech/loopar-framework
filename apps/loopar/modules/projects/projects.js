'use strict';

/*
 * Project helpers for apps. A Project only holds what every app shares
 * (title, customer, site, dates, state); the app that creates one says where
 * it came from with `document` / `documentName` (its own record), so the
 * same record never opens two projects.
 */

import { loopar } from 'loopar';

const PROJECT = 'Project';

/** Shared fields an app may set on a Project. */
export const PROJECT_FIELDS = ['title', 'customer', 'manager', 'start_date', 'end_date', 'address', 'city', 'state', 'zip_code', 'description', 'notes'];

const pick = (data) => Object.fromEntries(PROJECT_FIELDS.filter((f) => data[f] !== undefined && data[f] !== null).map((f) => [f, data[f]]));

/** True when the projects module is installed in this tenant. */
export const projectsAvailable = () => !!loopar.getRef(PROJECT, false);

/** Name of the project created from record `documentName` of `document`, or null. */
export async function projectOf(document, documentName) {
  if (!document || !documentName) return null;
  // getAll: getDoc only filters by `name`.
  const [row] = await loopar.db.getAll(PROJECT, ['name'], { document, document_name: documentName });
  return row?.name || null;
}

/**
 * Creates a Project from `data` (PROJECT_FIELDS; `customer` is the core
 * Customer). With `document` / `documentName`, the project of that record is
 * reused when it already has one. Returns the project name.
 */
export async function createProject(data = {}, { document = null, documentName = null } = {}) {
  const existing = await projectOf(document, documentName);
  if (existing) return existing;

  const doc = await loopar.newDocument(PROJECT);
  Object.assign(doc, pick(data));
  doc.document = document;
  doc.document_name = documentName;
  await doc.save();
  return doc.name;
}
