'use strict';

/**
 * Desk Pages: desk-only pages built with the Desk Page Builder (shortcuts,
 * number cards, quick lists, module cards…). One page per app can be its
 * home: the desk sidebar opens it when the app is picked in the rail.
 *
 * Pages are files (apps/<app>/modules/<module>/desk-pages/<page>/), so they
 * are read from refs + their JSON, like print formats.
 */
import { loopar } from '../loopar.js';
import { fileManage } from '../file-manage.js';
import { PermissionManager, SCOPE } from '../auth/PermissionManager.js';
import { isAuditableEntity, CREATED_BY_COLUMN } from '../global/audit.js';

export const DESK_PAGE_TYPE = "Desk Page";

/** Elements that read data through DeskPageController (see deskElementData). */
export const DESK_DATA_ELEMENTS = new Set(["shortcut", "number_card", "quick_list"]);

const truthy = (v) => loopar.utils.trueValue(v);

function readPage(ref) {
  const cfg = fileManage.getConfigFile(ref.__NAME__, ref.__ROOT__);
  if (!cfg) return null;
  return { ...cfg, name: cfg.name || ref.__NAME__, __APP__: ref.__APP__ };
}

export function listDeskPages(app = null) {
  return Object.values(loopar.getRefs() || {})
    .filter(ref => ref.__TYPE__ === DESK_PAGE_TYPE && (!app || loopar.utils.compare(ref.__APP__, app)))
    .map(readPage)
    .filter(Boolean);
}

/** { [app]: pageName } — the page each app opens as its home. */
export function deskHomes() {
  const homes = {};
  for (const page of listDeskPages()) {
    if (truthy(page.is_home) && !homes[page.__APP__]) homes[page.__APP__] = page.name;
  }
  return homes;
}

function findNode(nodes, key) {
  for (const node of nodes || []) {
    if (node?.node === key) return node;
    const found = findNode(node?.elements, key);
    if (found) return found;
  }
  return null;
}

/** Desk page structure as stored in its file (never what the client sends). */
export function deskPageNode(pageName, nodeKey) {
  const ref = loopar.getRef(pageName, false);
  if (!ref || ref.__TYPE__ !== DESK_PAGE_TYPE) return null;
  const cfg = fileManage.getConfigFile(ref.__NAME__, ref.__ROOT__) || {};
  return findNode(loopar.utils.JSONparse(cfg.doc_structure, []), nodeKey);
}

/**
 * Filter written in the element editor: a JSON object of `field: value`
 * equalities. Values may use tokens: "@me" (current user), "@today"
 * (YYYY-MM-DD). Unknown fields are dropped.
 */
export function parseDeskFilter(raw, ref) {
  const parsed = typeof raw === "object" && raw ? raw : loopar.utils.JSONparse(raw, {});
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

  const fields = new Set([...(ref.__FIELDS__ || []), "id", "name", CREATED_BY_COLUMN, "__document_status__"]);
  const today = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const tokens = {
    "@me": loopar.auth.user(),
    "@today": `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`,
  };

  const out = {};
  for (const [field, value] of Object.entries(parsed)) {
    if (!fields.has(field) || (value !== null && typeof value === "object")) continue;
    out[field] = typeof value === "string" && value in tokens ? tokens[value] : value;
  }
  return out;
}

/**
 * Query of `entity` as `user` sees it: null when the user can't list it;
 * narrowed to the user's records when their list scope is "own".
 */
function scopedQuery(entity, filter, user) {
  const ref = loopar.getRef(entity, false);
  if (!ref || ref.is_single || ref.is_child || ref.__TYPE__ !== "Entity") return null;

  const scope = PermissionManager.scope(ref.__NAME__, "list", user);
  if (!scope) return null;

  const where = parseDeskFilter(filter, ref);
  if (scope === SCOPE.OWN) where[CREATED_BY_COLUMN] = user ?? "__nobody__";

  let qb = loopar.db.qx()(ref.__NAME__);
  const cb = loopar.db.buildWhereCb(where);
  if (cb) qb = qb.where(cb);
  if (isAuditableEntity(ref)) qb = qb.whereNull("__deleted_at__");
  return { qb, ref };
}

async function aggregate(data, user) {
  const q = scopedQuery(data.entity, data.filter, user);
  if (!q) return { denied: true };

  const fn = ["sum", "avg", "min", "max"].includes(data.aggregate) ? data.aggregate : "count";
  if (fn !== "count" && !(q.ref.__FIELDS__ || []).includes(data.field)) {
    return { issue: `Field "${data.field || ""}" is not in ${q.ref.__NAME__}` };
  }

  const row = await q.qb[fn]({ value: fn === "count" ? "id" : data.field }).first();
  return { value: Number(row?.value || 0) };
}

async function quickList(data, user) {
  const q = scopedQuery(data.entity, data.filter, user);
  if (!q) return { denied: true };

  const known = new Set(q.ref.__FIELDS__ || []);
  const fields = String(data.fields || "")
    .split(",").map(f => f.trim()).filter(f => f && known.has(f));
  const limit = Math.min(Math.max(parseInt(data.limit, 10) || 5, 1), 50);

  const rows = await q.qb
    .select(["name", ...fields.filter(f => f !== "name")])
    .orderBy("id", "desc")
    .limit(limit);

  return { entity: q.ref.__NAME__, fields, rows };
}

/**
 * Data of one element of a desk page, read from the page file by node key
 * (the client only says which element) and filtered by the user's
 * permissions on the entity it reads.
 */
export async function deskElementData(pageName, nodeKey, user = loopar.auth.user()) {
  const node = deskPageNode(pageName, nodeKey);
  if (!node || !DESK_DATA_ELEMENTS.has(node.element)) return { issue: "Element not found" };

  const data = node.data || {};

  if (node.element === "shortcut") {
    if (!truthy(data.show_count) || !data.target) return {};
    return await aggregate({ entity: data.target, filter: data.filter }, user);
  }
  if (node.element === "number_card") return await aggregate(data, user);
  if (node.element === "quick_list") return await quickList(data, user);
  return {};
}
