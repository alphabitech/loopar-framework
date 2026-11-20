'use strict';

import {
  PageController, loopar, fileManage, PermissionManager, SCOPE, CREATED_BY_COLUMN,
  portalIdentity, portalCondition, listPrintFormats, printKind, formatPrintValue,
} from 'loopar';

const RECENT = 5;
const STATUS_FIELD = 'status';

/**
 * Portal home (`/portal`): the signed-in user's own documents, one card per
 * entity the user may list with scope 'portal' (records of the subjects the
 * user belongs to, see core/auth/portal-scope.js) or 'own'.
 *
 * Nothing to configure: an app shows a document here by granting the portal
 * role `list` on it. Each row opens the customer-facing print format when the
 * role may `print` and the entity has one, else the read-only view. A
 * controller may add row actions for its portal users:
 *
 *   static portalActions = [
 *     { action: 'approvalLink', label: 'Review & approve', when: { status: 'Sent' } },
 *   ];
 *
 * The action must be granted to the role too; the row link is
 * `/portal/<Entity>/<action>?name=…` (a GET that usually redirects).
 */
export default class PortalHomeController extends PageController {
  static freeActions = ['view', 'summary'];

  constructor(props) {
    super(props);
  }

  async actionSummary() {
    const user = loopar.auth.user();
    if (!user) loopar.throw({ code: 401, message: 'Sign in to see your account.' });
    return await portalSummary(user);
  }
}

/** The portal home of `user`: { account, sections }. */
export async function portalSummary(user) {
  const me = await loopar.db.getRow('User', user, ['name', 'email', 'first_name', 'last_name', 'user_type', 'must_change_password']);
  const sections = [];
  for (const entity of portalEntities(user)) {
    try {
      const section = await entitySection(entity, user);
      if (section) sections.push(section);
    } catch (e) {
      // One broken entity must not take the whole home down.
      console.warn(`[portal-home] ${entity}:`, e?.message || e);
    }
  }

  return {
    account: {
      user,
      email: me?.email || null,
      name: [me?.first_name, me?.last_name].filter(Boolean).join(' ') || user,
      desk_user: me?.user_type !== 'Web',
      must_change_password: [1, '1', true].includes(me?.must_change_password),
    },
    sections,
  };
}

const can = (entity, action, user) => PermissionManager.scope(entity, action, user, { includePublic: false });

/** Entities of the desk menu the user lists as a portal user, in menu order. */
function portalEntities(user) {
  const seen = new Set();
  for (const app of loopar.deskMenu || []) {
    for (const m of app.modules || []) {
      for (const r of m.routes || []) {
        const entity = r.description;
        if (!entity || seen.has(entity)) continue;
        const scope = can(entity, 'list', user);
        if (scope === SCOPE.PORTAL || scope === SCOPE.OWN) seen.add(entity);
      }
    }
  }
  return [...seen];
}

/** The fields of an entity as list columns (DynamicField: element + data). */
function listedFields(doc) {
  const fields = Object.values(doc.fields || {}).filter((f) => f?.name && f.name !== '__ENTITY__' && f.element);
  const listed = fields.filter((f) => [1, '1', true].includes(f.in_list_view));
  return listed.length ? listed : fields.filter((f) => f.name === 'name');
}

async function controllerOf(entity) {
  const ref = loopar.getRef(entity, false);
  if (!ref?.__ROOT__) return null;
  try {
    return await fileManage.importClass(loopar.makePath(ref.__ROOT__, `${entity}Controller.js`));
  } catch {
    return null;
  }
}

const matches = (row, when) => !when || Object.entries(when).every(([k, v]) =>
  Array.isArray(v) ? v.includes(row[k]) : row[k] === v);

async function entitySection(entity, user) {
  const scope = can(entity, 'list', user);
  const filter = scope === SCOPE.PORTAL
    ? await portalCondition(entity, await portalIdentity(user))
    : { [CREATED_BY_COLUMN]: user };

  const doc = await loopar.newDocument(entity);
  const fields = listedFields(doc);
  const names = [...new Set(['name', ...fields.map((f) => f.name), ...(doc.fields?.[STATUS_FIELD] ? [STATUS_FIELD] : [])])];

  const all = await loopar.db.getAll(entity, ['id', ...names], filter, { orderBy: [{ column: 'id', order: 'desc' }] });
  if (!all.length) return null;
  const rows = all.slice(0, RECENT);

  const printable = can(entity, 'print', user) !== null && listPrintFormats(entity).length > 0;
  const openAction = printable ? 'print' : (can(entity, 'view', user) !== null ? 'view' : null);
  const Controller = await controllerOf(entity);
  const extra = (Controller?.portalActions || []).filter((a) => a?.action && can(entity, a.action, user) !== null);

  const titles = await doc.linkTitles(rows);
  const columns = fields.filter((f) => f.name !== 'name' && f.name !== STATUS_FIELD);
  const href = (action, name) => `/portal/${encodeURIComponent(entity)}/${action}?name=${encodeURIComponent(name)}`;

  return {
    entity,
    label: loopar.utils.Capitalize(entity),
    total: all.length,
    more: all.length > RECENT && scope !== null ? `/portal/${encodeURIComponent(entity)}/list` : null,
    columns: columns.map((f) => ({ name: f.name, label: f.label || f.name, numeric: ['money', 'decimal', 'int'].includes(printKind(f.element, f)) })),
    rows: rows.map((row) => ({
      name: row.name,
      status: row[STATUS_FIELD] ?? null,
      cells: Object.fromEntries(columns.map((f) => [f.name, formatPrintValue(printKind(f.element, f), row[f.name], { data: f, titles })])),
      open: openAction ? href(openAction, row.name) : null,
      actions: extra.filter((a) => matches(row, a.when)).map((a) => ({ label: a.label || a.action, href: href(a.action, row.name), primary: !!a.primary })),
    })),
  };
}
