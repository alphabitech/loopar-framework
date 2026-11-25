'use strict';

/**
 * Referential integrity of CONNECTION fields, enforced in the ORM write
 * pipeline (KnexORM before* events) instead of the document model. Every
 * insertRow / updateRow / deleteRow / deleteWhere goes through it, whoever
 * calls it — a model, a controller, an app helper or a job.
 *
 *   - create/update: an empty connection is stored as NULL, and every value
 *     written to a connection field must name an existing (not soft-deleted)
 *     record of the target entity. On PG/MySQL the target rows are read FOR
 *     SHARE, so they can't be deleted until the write commits.
 *   - delete (hard or soft): refused while any record still points to the
 *     row. The row is locked FOR UPDATE first, so a concurrent write that
 *     points to it either waits and then fails, or commits before the check
 *     and is seen by it.
 *
 * In a tenant in "warn" integrity mode (core/global/integrity-mode.js) the
 * refusals are only logged.
 *
 * The model keeps its own validation (validateLinkDocuments) for the form:
 * all errors at once, cascade/filters, virtual targets. This layer is the
 * guarantee underneath it, and the database foreign keys (foreign-keys.js)
 * the last one.
 *
 * Not covered: raw SQL and direct query-builder writes (qx()(table)...),
 * which skip the ORM. Those are framework paths (installer, backup restore,
 * tenant migration, child-row cleanup) and run unchecked on purpose.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { loopar } from "../loopar.js";
import { multipleValues } from "../global/element-definition.js";
import { violation } from "../global/integrity-mode.js";

const SKIP_SOURCES = new Set(["document history"]);
const SINGLE_VALUES = "Document Single Values";
const MAX_LISTED = 20;

const bypass = new AsyncLocalStorage();

/** Runs `fn` with the checks off (uninstalling an app removes records in any order). */
export function withoutReferenceChecks(fn) {
  return bypass.run(true, fn);
}

export const referenceChecksOff = () => bypass.getStore() === true || !!loopar.installing;

const key = (name) => loopar.utils.toEntityKey(name);

// ── Link index ──────────────────────────────────────────────────────────────
// Built from the refs' __FIELD_META__; rebuilt whenever buildRefs() replaces
// the tenant's refs object.
const indexCache = new WeakMap();

const EMPTY_INDEX = Object.freeze({ outgoing: new Map(), incoming: new Map(), childParents: new Map() });

/**
 *   outgoing:     source key → [{ field, target, multiple }]
 *   incoming:     target key → [{ entity, field, multiple, single, child }]
 *   childParents: child key  → [parent entity names] (FORM_TABLE fields)
 */
export function linkIndex() {
  const all = loopar.__REFS__;
  if (!all) return EMPTY_INDEX;
  const cached = indexCache.get(all);
  if (cached) return cached;

  const refs = loopar.getRefs();
  const outgoing = new Map();
  const incoming = new Map();
  const childParents = new Map();
  const push = (map, k, v) => { if (!map.has(k)) map.set(k, []); map.get(k).push(v); };

  for (const ref of Object.values(refs)) {
    if (ref.is_virtual) continue;
    for (const [field, meta] of Object.entries(ref.__FIELD_META__ || {})) {
      if (!meta.options) continue;
      const target = refs[key(meta.options)];
      if (!target || target.is_virtual) continue;

      if (meta.element === FORM_TABLE) {
        if (!target.is_child) continue;
        const parents = childParents.get(key(target.__NAME__)) || [];
        if (!parents.includes(ref.__NAME__)) push(childParents, key(target.__NAME__), ref.__NAME__);
        continue;
      }
      if (meta.element !== CONNECTION || SKIP_SOURCES.has(String(ref.__NAME__).toLowerCase())) continue;

      const link = { field, target: target.__NAME__, multiple: !!meta.multiple, required: !!meta.required };
      push(outgoing, key(ref.__NAME__), link);
      push(incoming, key(target.__NAME__), {
        entity: ref.__NAME__, field, multiple: link.multiple,
        single: !!ref.is_single, child: !!ref.is_child,
      });
    }
  }

  const index = { outgoing, incoming, childParents };
  indexCache.set(all, index);
  return index;
}

// Foreign keys the database enforces in each tenant ("table\0column"), set by
// foreign-keys.js after a sync: the existence of those values needn't be read
// again here when the target has no soft delete (the database can't see it).
const enforced = new Map();

export function setEnforcedForeignKeys(keys, tenantName = loopar.tenantId) {
  enforced.set(tenantName || "__default__", new Set(keys));
}

const isEnforced = (table, column) =>
  !!enforced.get(loopar.tenantId || "__default__")?.has(`${key(table)}\u0000${String(column).toLowerCase()}`);

// ── Helpers ─────────────────────────────────────────────────────────────────
const locks = (db) => !String(db.dialect).toLowerCase().includes("sqlite");
const isAudited = (entity) => !!loopar.getRef(entity, false)?.is_audited;

function valuesOf(raw, multiple) {
  if (raw === undefined || raw === null || raw === "") return [];
  if (typeof raw === "object" && !Array.isArray(raw)) return []; // knex expression, not a value
  return multiple ? multipleValues(raw) : [String(raw)];
}

const sameValue = (a, b) => String(a ?? "") === String(b ?? "");

// A multiple connection stores a JSON array: match the quoted name inside it.
// "!" escapes LIKE wildcards: unlike "\\" it means the same on every dialect.
const likeJsonItem = (name) => `%${JSON.stringify(String(name)).replace(/[!%_]/g, (c) => `!${c}`)}%`;

function whereValue(qb, column, name, multiple) {
  return multiple
    ? qb.whereRaw(`?? LIKE ? ESCAPE '!'`, [column, likeJsonItem(name)])
    : qb.where(column, String(name));
}

// ── Writes: every connection value must exist ───────────────────────────────
async function checkOutgoing(db, document, name, doc, before = null, isUpdate = false) {
  if (!doc) return;
  const links = linkIndex().outgoing.get(key(document));
  if (!links) return;

  // An empty connection is "no value": NULL, which a foreign key accepts.
  // A required one keeps '' (its column is NOT NULL): the model reports it.
  for (const link of links) if (doc[link.field] === "" && !link.required) doc[link.field] = null;
  if (referenceChecksOff()) return;

  const present = links.filter((link) => link.field in doc);
  if (!present.length) return;

  // Entities without audit columns don't load the stored row: read the
  // connection columns, so unchanged values aren't checked again.
  if (isUpdate && !before && name != null) {
    before = await db.qx()(document).where({ name }).first(present.map((l) => l.field)) || null;
  }

  const errors = [];
  for (const link of present) {
    if (before && link.field in before && sameValue(before[link.field], doc[link.field])) continue;

    const values = [...new Set(valuesOf(doc[link.field], link.multiple))];
    if (!values.length) continue;

    const audited = isAudited(link.target);
    // The database guarantees it and there's no soft delete to look at.
    if (!link.multiple && !audited && isEnforced(document, link.field)) continue;

    let qb = db.qx()(link.target).whereIn("name", values).select("name");
    if (audited) qb = qb.whereNull("__deleted_at__");
    if (locks(db)) qb = qb.forShare();

    const found = new Set((await qb).map((r) => String(r.name)));
    for (const value of values) {
      if (!found.has(value)) errors.push(`The value ${value} for ${link.field} does not exist in ${link.target} Entity`);
    }
  }

  if (errors.length) violation({ ...VALIDATION_ERROR, message: errors.join("<br/>") });
}

// ── Deletes: nothing may still point to the row ─────────────────────────────
/** Records that point to `document`.`name` through a connection field: [{ entity, name }]. */
export async function connectedDocuments(db, document, name, { limit = MAX_LISTED } = {}) {
  const sources = linkIndex().incoming.get(key(document)) || [];
  const found = [];

  for (const src of sources) {
    if (found.length >= limit) break;
    const left = limit - found.length;

    if (src.single) {
      let qb = db.qx()(SINGLE_VALUES).where({ document: src.entity, field: src.field });
      qb = whereValue(qb, "value", name, src.multiple);
      if (await qb.first("name")) found.push({ entity: src.entity, name: src.entity });
      continue;
    }

    const cols = src.child ? ["name", "parent_document", "parent_id"] : ["name"];
    let qb = db.qx()(src.entity).select(cols).limit(left);
    qb = whereValue(qb, src.field, name, src.multiple);
    if (isAudited(src.entity)) qb = qb.whereNull("__deleted_at__");
    // A record pointing to itself does not keep itself alive.
    if (key(src.entity) === key(document)) qb = qb.whereNot("name", name);

    for (const row of await qb) {
      if (!src.child) { found.push({ entity: src.entity, name: row.name }); continue; }
      // A child row is reached through its parent document.
      const parent = row.parent_document && row.parent_id != null
        ? await db.qx()(row.parent_document).where({ id: row.parent_id }).first("name")
        : null;
      found.push(parent
        ? { entity: row.parent_document, name: parent.name }
        : { entity: src.entity, name: row.name });
    }
  }

  return found;
}

async function checkIncoming(db, document, doc) {
  const name = doc?.name;
  if (referenceChecksOff() || name === undefined || name === null || name === "") return;
  if (!linkIndex().incoming.has(key(document))) return;

  if (locks(db)) await db.qx()(document).where({ name }).forUpdate().first("id");

  const connections = await connectedDocuments(db, document, name);
  if (!connections.length) return;

  const seen = new Set();
  const list = connections.filter((c) => {
    const k = `${c.entity}\u0000${c.name}`;
    return seen.has(k) ? false : seen.add(k);
  }).map((e, i) =>
    `<a href='/desk/${e.entity}/update?name=${encodeURIComponent(e.name)}'>${i + 1}: <strong>${e.entity}</strong>.${e.name}</a>`
  ).join("<br/>");

  violation({
    ...VALIDATION_ERROR,
    message: `<h2>Is not possible to delete ${document}.${name} because it is connected to:</h2><br/> ${list}`,
  });
}

/**
 * Deletes the records of `entity` matching `filter` one by one through their
 * documents, so each runs its own rules and hooks — the framework's version
 * of a cascade (the database never cascades). Nothing when the entity isn't
 * installed. Run it inside the caller's transaction.
 */
export async function deleteRecords(entity, filter, options = {}) {
  if (!loopar.getRef(entity, false)) return 0;
  const rows = await loopar.db.getAll(entity, ["name"], filter);
  for (const { name } of rows) {
    const doc = await loopar.getDocument(entity, name, null, { ifNotFound: null });
    if (doc) await doc.delete(options);
  }
  return rows.length;
}

let wired = false;

/** Called once at boot. The KnexORM pipeline is static: handlers get the emitting instance as `db`. */
export function setupReferentialIntegrity(KnexORM) {
  if (wired) return;
  wired = true;
  KnexORM.on("beforeCreate", ({ db, document, doc }) => checkOutgoing(db, document, doc?.name, doc));
  KnexORM.on("beforeUpdate", ({ db, document, name, doc, before }) => checkOutgoing(db, document, name, doc, before, true));
  KnexORM.on("beforeDelete", ({ db, document, doc }) => checkIncoming(db, document, doc));
}
