'use strict';

import { loopar, tenant } from "loopar";
import { sourceLockEnabled } from "../config/core-config.js";

/**
 * Source lock.
 *
 * Entities, builders and the records built with them (pages, forms, views,
 * controllers, print formats…), App and Module are not tenant data: saving one
 * writes the app's files under apps/ and alters schemas. The apps folder is
 * shared by every tenant on the server, so a change made from one tenant's
 * desk changes the system for all of them.
 *
 * With the lock on (production by default, see `sourceLockEnabled`), nobody
 * changes them from the desk, the Administrator included: they open read-only,
 * and they are changed in development and deployed. Only desk requests are
 * gated; programmatic flows (installer, provisioning, deploy) never pass here.
 */

/** Source documents that are not builders. Builders (`ref.is_builder`) always are. */
const SOURCE_DOCUMENTS = new Set(["app", "module", "appmanager"]);

/** Actions that only read: allowed on every locked document. */
const READ_ACTIONS = new Set([
  "view", "list", "search", "board", "calendar", "tree", "map", "geocode", "report", "export", "print", "history",
  "orphancolumns",
]);

/**
 * Per-document actions that stay allowed. App Manager: git state is read-only
 * (status, diff, accounts), and installing / updating an app in this tenant
 * only touches the tenant's database — that is how a deploy reaches a tenant.
 */
const EXTRA_ALLOWED = {
  appmanager: new Set(["status", "diff", "gitaccounts", "install", "update", "reinstall", "uninstall", "testconnection"]),
};

/**
 * Deploy actions: bring the apps' source from git into the shared apps folder.
 * Allowed only on the server owner's tenants — the control plane and the
 * template host (pull + Update refreshes the demos); from any other tenant
 * they would deploy code for everyone. Commit, push, discard and publish
 * are development work and stay locked everywhere.
 */
const CONTROL_PLANE_ALLOWED = {
  appmanager: new Set(["pull", "clone", "publishdemo"]),
};

/** Writes the client hides on locked documents (cosmetic: the server enforces). */
const CLIENT_DENIED_ACTIONS = [
  "create", "update", "delete", "bulkdelete", "bulkupdate", "rename", "import",
  "changeprotected", "transition", "bulktransition",
];
const CLIENT_DENIED_EXTRA = {
  appmanager: ["pull", "clone", "publishdemo", "commit", "push", "discard", "publish"],
};

const normDoc = (d) => String(d ?? "").toLowerCase().replaceAll(" ", "");
const normAct = (a) => String(a ?? "").toLowerCase();

/** Is the request's tenant one of the server owner's (control plane or template host)? */
const onOwnerTenant = () => {
  try {
    const name = loopar.requestTenantId;
    return !!name && (tenant.isControlPlane(name) || tenant.isTemplateHost(name));
  } catch { return false; }
};

/** Is `act` allowed on the locked document `doc` (both normalized)? */
function allowedWhileLocked(doc, act) {
  if (READ_ACTIONS.has(act)) return true;
  if (EXTRA_ALLOWED[doc]?.has(act)) return true;
  return !!CONTROL_PLANE_ALLOWED[doc]?.has(act) && onOwnerTenant();
}

/** Is `document` app source (regardless of the lock being on)? */
export function isSourceDocument(document) {
  if (!document) return false;
  if (SOURCE_DOCUMENTS.has(normDoc(document))) return true;
  return !!loopar.getRef?.(document)?.is_builder;
}

/** Is `document` app source and the lock on? */
export function isSourceLocked(document) {
  return sourceLockEnabled() && isSourceDocument(document);
}

/** Would `action` on `document` change app source while the lock is on? */
export function isSourceLockedAction(document, action) {
  if (!isSourceLocked(document)) return false;
  return !allowedWhileLocked(normDoc(document), normAct(action));
}

/** Permission keys (`doc:action`) the client must treat as denied, for every user. */
export function sourceLockedKeys() {
  if (!sourceLockEnabled()) return [];
  const docs = new Set(SOURCE_DOCUMENTS);
  for (const ref of Object.values(loopar.getRefs?.() ?? {})) {
    if (ref?.is_builder) docs.add(normDoc(ref.__NAME__));
  }
  const keys = [];
  for (const doc of docs) {
    for (const act of [...CLIENT_DENIED_ACTIONS, ...(CLIENT_DENIED_EXTRA[doc] ?? [])]) {
      if (!allowedWhileLocked(doc, act)) keys.push(`${doc}:${act}`);
    }
  }
  return keys;
}

/** Message for a refused write. */
export const sourceLockedMessage = (document, action) => {
  const doc = normDoc(document), act = normAct(action);
  if (CONTROL_PLANE_ALLOWED[doc]?.has(act)) {
    return `${document} → ${action}: in production it runs only on the server owner's tenant (control plane or template host).`;
  }
  return `${document} → ${action}: part of the apps' source, it can't be changed in production. Change it in development and deploy.`;
};
