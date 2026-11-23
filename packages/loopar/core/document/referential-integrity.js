'use strict';

/**
 * Referential integrity of CONNECTION fields, enforced in the ORM write
 * pipeline (KnexORM before* events) instead of the document model. Every
 * insertRow / updateRow / deleteRow goes through it, whoever calls it — a
 * model, a controller, an app helper or a job.
 *
 *   - create/update: every value written to a connection field must name an
 *     existing (not soft-deleted) record of the target entity. On PG/MySQL
 *     the target rows are read FOR SHARE, so they can't be deleted until the
 *     write commits.
 *   - delete (hard or soft): refused while any record still points to the
 *     row. The row is locked FOR UPDATE first, so a concurrent write that
 *     points to it either waits and then fails, or commits before the check
 *     and is seen by it.
 *
 * The model keeps its own validation (validateLinkDocuments) for the form:
 * all errors at once, cascade/filters, virtual targets. This layer is the
 * guarantee underneath it.
 *
 * Not covered: raw SQL and direct query-builder writes (qx()(table)...),
 * which skip the ORM. Those are framework paths (installer, backup restore,
 * tenant migration, child-row cleanup) and run unchecked on purpose.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { loopar } from "../loopar.js";
import { multipleValues } from "../global/element-definition.js";

const SKIP_SOURCES = new Set(["document history"]);
const SINGLE_VALUES = "Document Single Values";
const MAX_LISTED = 20;

const bypass = new AsyncLocalStorage();

/** Runs `fn` with the checks off (uninstalling an app removes records in any order). */
export function withoutReferenceChecks(fn) {
  return bypass.run(true, fn);
}

const checksOff = () => bypass.getStore() === true || !!loopar.installing;

// ── Link index
// Built from the refs' __FIELD_META__; rebuilt whenever buildRefs() replaces
// the tenant's refs object.
const indexCache = new WeakMap();

function linkIndex() {
  const all = loopar.__REFS__;
  if (!all) return { outgoing: new Map(), incoming: new Map() };
  const cached = indexCache.get(all);
  if (cached) return cached;

  const refs = loopar.getRefs();
  const key = (name) => loopar.utils.toEntityKey(name);
  const outgoing = new Map();   // source key → [{ field, target, multiple }]
  const incoming = new Map();   // target key → [{ entity, field, multiple, single, child }]

  for (const ref of Object.values(refs)) {
    if (ref.is_virtual || SKIP_SOURCES.has(String(ref.__NAME__).toLowerCase())) continue;
    for (const [field, meta] of Object.entries(ref.__FIELD_META__ || {})) {
      if (meta.element !== CONNECTION || !meta.options) continue;
      const target = refs[key(meta.options)];
      if (!target || target.is_virtual) continue;

      const link = { field, target: target.__NAME__, multiple: !!meta.multiple };
      if (!outgoing.has(key(ref.__NAME__))) outgoing.set(key(ref.__NAME__), []);
      outgoing.get(key(ref.__NAME__)).push(link);

      if (!incoming.has(key(target.__NAME__))) incoming.set(key(target.__NAME__), []);
      incoming.get(key(target.__NAME__)).push({
        entity: ref.__NAME__, field, multiple: link.multiple,
        single: !!ref.is_single, child: !!ref.is_child,
      });
    }
  }

  const index = { outgoing, incoming };
  indexCache.set(all, index);
  return index;
}

// ── Helpers
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

// ── Writes: every connection value must exist
async function checkOutgoing(db, document, doc, before = null) {
  if (checksOff() || !doc) return;
  const links = linkIndex().outgoing.get(loopar.utils.toEntityKey(document));
  if (!links) return;

  const errors = [];
  for (const link of links) {
    if (!(link.field in doc)) continue;
    if (before && link.field in before && sameValue(before[link.field], doc[link.field])) continue;

    const values = [...new Set(valuesOf(doc[link.field], link.multiple))];
    if (!values.length) continue;

    let qb = db.qx()(link.target).whereIn("name", values).select("name");
    if (isAudited(link.target)) qb = qb.whereNull("__deleted_at__");
    if (locks(db)) qb = qb.forShare();

    const found = new Set((await qb).map((r) => String(r.name)));
    for (const value of values) {
      if (!found.has(value)) errors.push(`The value ${value} for ${link.field} does not exist in ${link.target} Entity`);
    }
  }

  if (errors.length) loopar.throw({ ...VALIDATION_ERROR, message: errors.join("<br/>") });
}

// ── Deletes: nothing may still point to the row
/** Records that point to `document`.`name` through a connection field: [{ entity, name }]. */
export async function connectedDocuments(db, document, name, { limit = MAX_LISTED } = {}) {
  const sources = linkIndex().incoming.get(loopar.utils.toEntityKey(document)) || [];
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
    if (loopar.utils.toEntityKey(src.entity) === loopar.utils.toEntityKey(document)) qb = qb.whereNot("name", name);

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
  if (checksOff() || name === undefined || name === null || name === "") return;
  if (!linkIndex().incoming.has(loopar.utils.toEntityKey(document))) return;

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

  loopar.throw({
    ...VALIDATION_ERROR,
    message: `<h2>Is not possible to delete ${document}.${name} because it is connected to:</h2><br/> ${list}`,
  });
}

let wired = false;

/** Called once at boot. The KnexORM pipeline is static: handlers get the emitting instance as `db`. */
export function setupReferentialIntegrity(KnexORM) {
  if (wired) return;
  wired = true;
  KnexORM.on("beforeCreate", ({ db, document, doc }) => checkOutgoing(db, document, doc));
  KnexORM.on("beforeUpdate", ({ db, document, doc, before }) => checkOutgoing(db, document, doc, before));
  KnexORM.on("beforeDelete", ({ db, document, doc }) => checkIncoming(db, document, doc));
}
