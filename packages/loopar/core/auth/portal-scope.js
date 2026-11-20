'use strict';

import fs from "fs";
import path from "pathe";
import { pathToFileURL } from "url";
import { Op } from "db-env";
import { loopar } from "loopar";
import { getRequest } from "../server/router/request-context.js";

/*
 * Portal identity and the 'portal' permission scope.
 *
 * The framework knows that a portal user (a Web user outside the staff)
 * reaches only the records of the *subjects* it belongs to; it does not know
 * what a subject is. An installed app provides that in `apps/<app>/portal.js`:
 *
 *   export default {
 *     field: "customer",              // column that links records to a subject
 *     subjectEntity: "Customer",      // the subject itself, matched by `name`
 *     contactEntity: "Customer Contact", // the user's own record, matched by `name`
 *     async resolve(user) {           // who is this user: built by staff, never inferred
 *       return { contact: "CC-0001", subjects: ["CUST-0001"] };
 *     },
 *   };
 *
 * Every app that serves a portal resolves "who is this user" here, never by
 * matching emails and never from a name sent by the client. Records an app
 * exposes to the portal carry the provider's `field`; a grant with scope
 * 'portal' narrows them to the identity's subjects. A tenant with no provider
 * installed has no portal identities: the scope reaches nothing.
 */

const NOBODY = "__nobody__";
const CACHE_KEY = "__PORTAL_IDENTITY__";
const PROVIDER_FILE = "portal.js";

const EMPTY = (user) => Object.freeze({ user: user ?? null, contact: null, subjects: Object.freeze([]) });

const loaded = new Map(); // app -> Promise<provider | null>

function loadProvider(app) {
  if (!loaded.has(app)) {
    const file = path.join(loopar.pathRoot, "apps", app, PROVIDER_FILE);
    loaded.set(app, !fs.existsSync(file)
      ? Promise.resolve(null)
      : import(pathToFileURL(file).href)
          .then((mod) => mod.default || null)
          .catch((e) => {
            console.warn(`[portal] ${app}/${PROVIDER_FILE}: ${e.message}`);
            return null;
          }));
  }
  return loaded.get(app);
}

/** The portal provider of the current tenant (first installed app that ships one), or null. */
export async function portalProvider() {
  for (const app of Object.keys(loopar.installedApps || {}).sort()) {
    const provider = await loadProvider(app);
    if (provider && typeof provider.resolve === "function") return provider;
  }
  return null;
}

async function loadIdentity(user) {
  if (!user) return EMPTY(user);
  const provider = await portalProvider();
  if (!provider) return EMPTY(user);
  const found = await provider.resolve(user);
  const subjects = [...new Set((found?.subjects || []).filter((s) => s != null))];
  return Object.freeze({ user, contact: found?.contact ?? null, subjects: Object.freeze(subjects) });
}

/**
 * Identity of `user` (the logged-in user by default):
 * `{ user, contact, subjects }` — contact is null and subjects empty when
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
 * signed in (401) or the user is not linked to any subject (403).
 */
export async function requirePortalIdentity({ message } = {}) {
  const user = loopar.auth.user();
  if (!user) loopar.throw({ code: 401, message: "Sign in to see your account." });
  const identity = await portalIdentity(user);
  if (!identity.subjects.length) {
    loopar.throw({
      code: 403,
      message: message || "Your user is not linked to an account yet. Please contact us to get access.",
    });
  }
  return identity;
}

/**
 * Column of `entity` that links it to a subject: `name` for the subject
 * entity itself, `field` (or the provider's field) for any other.
 */
export async function portalFieldOf(entity, field) {
  const provider = await portalProvider();
  if (provider?.subjectEntity && entity === provider.subjectEntity) return "name";
  return field || provider?.field || NOBODY;
}

/** Filter that narrows `entity` to the records of `identity`. */
export async function portalCondition(entity, identity, field) {
  const provider = await portalProvider();
  if (provider?.contactEntity && entity === provider.contactEntity) return { name: identity?.contact ?? NOBODY };
  const subjects = identity?.subjects ?? [];
  return { [await portalFieldOf(entity, field)]: subjects.length ? { [Op.in]: [...subjects] } : NOBODY };
}

/**
 * Does record `name` of `entity` belong to `identity`?
 * Null when the record doesn't exist (the action 404s as usual).
 */
export async function isPortalRecord(entity, name, identity, field) {
  const provider = await portalProvider();
  if (provider?.contactEntity && entity === provider.contactEntity) {
    const row = await loopar.db.getRow(entity, name, ["name"]);
    return row ? row.name === identity?.contact : null;
  }
  const column = await portalFieldOf(entity, field);
  const row = await loopar.db.getRow(entity, name, [column === "name" ? "name" : column]);
  if (!row) return null;
  const value = row[column];
  return value != null && (identity?.subjects ?? []).includes(value);
}

/** Does a private-file owner row belong to `identity`? (row already loaded) */
export async function isPortalRow(entity, row, identity) {
  const provider = await portalProvider();
  if (provider?.contactEntity && entity === provider.contactEntity) return row?.name === identity?.contact;
  const value = row?.[await portalFieldOf(entity)];
  return value != null && (identity?.subjects ?? []).includes(value);
}
