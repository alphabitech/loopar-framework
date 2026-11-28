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
  appmanager: new Set(["status", "diff", "gitaccounts", "versions", "install", "update", "reinstall", "uninstall", "testconnection", "job", "jobs", "dependents", "deskmenu", "migrations"]),
};

/**
 * Deploy actions: bring the apps' source from git into the shared apps folder.
 * Allowed only on the server owner's tenants — the control plane and the
 * template host (pull + Update refreshes the demos); from any other tenant
 * they would deploy code for everyone. Commit, push, discard and publish
 * are development work and stay locked everywhere.
 */
const CONTROL_PLANE_ALLOWED = {
  appmanager: new Set(["pull", "clone", "publishdemo", "switchversion"]),
};

/**
 * Code work: what reads, writes or replaces the shared apps folder (git, the
 * version the code is at, new migration files) and builds it. It runs only on
 * the server owner's tenant (control plane or template host), in development
 * too — not only under the production lock: one tenant brings the code and
 * builds it, the others only install, update or uninstall. That is also the
 * tenant that holds the Git Accounts.
 */
const OWNER_ONLY = {
  appmanager: new Set([
    "pull", "clone", "publishdemo", "switchversion", "versions",
    "commit", "push", "discard", "publish", "gitaccounts", "diff", "newmigration",
  ]),
};

/** Writes the client hides on locked documents (cosmetic: the server enforces). */
const CLIENT_DENIED_ACTIONS = [
  "create", "update", "delete", "bulkdelete", "bulkupdate", "rename", "import",
  "changeprotected", "transition", "bulktransition",
];
const CLIENT_DENIED_EXTRA = {
  appmanager: ["pull", "clone", "publishdemo", "switchversion", "commit", "push", "discard", "publish"],
};

const normDoc = (d) => String(d ?? "").toLowerCase().replaceAll(" ", "");
const normAct = (a) => String(a ?? "").toLowerCase();

/**
 * Is the request's tenant one of the server owner's (control plane or template
 * host)? The tenant that brings code to the server (pull, version switch) and
 * builds it; the others only install, update or uninstall.
 */
export const onOwnerTenant = () => {
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

/** Is `action` on `document` code work refused on this tenant (not the server owner's)? */
export function isOwnerOnlyAction(document, action) {
  return !!OWNER_ONLY[normDoc(document)]?.has(normAct(action)) && !onOwnerTenant();
}

/** Would `action` on `document` change app source while the lock is on (or is it owner-only code work here)? */
export function isSourceLockedAction(document, action) {
  if (isOwnerOnlyAction(document, action)) return true;
  if (!isSourceLocked(document)) return false;
  return !allowedWhileLocked(normDoc(document), normAct(action));
}

/** Permission keys (`doc:action`) the client must treat as denied, for every user. */
export function sourceLockedKeys() {
  // Code work, on a tenant that isn't the server owner's: lock or not.
  const ownerOnly = onOwnerTenant() ? [] : Object.entries(OWNER_ONLY)
    .flatMap(([doc, acts]) => [...acts].map((act) => `${doc}:${act}`));
  if (!sourceLockEnabled()) return ownerOnly;
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
  return [...new Set([...keys, ...ownerOnly])];
}

/** Message for a refused write. */
export const sourceLockedMessage = (document, action) => {
  const doc = normDoc(document), act = normAct(action);
  if (OWNER_ONLY[doc]?.has(act) && !onOwnerTenant()) {
    return `${document} → ${action}: code work runs only on the control plane tenant (it changes the apps for every site). Here, install, update or uninstall.`;
  }
  if (CONTROL_PLANE_ALLOWED[doc]?.has(act)) {
    return `${document} → ${action}: in production it runs only on the server owner's tenant (control plane or template host).`;
  }
  return `${document} → ${action}: part of the apps' source, it can't be changed in production. Change it in development and deploy.`;
};
