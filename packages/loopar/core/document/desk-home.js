'use strict';

/**
 * Data of the desk home elements (read through DeskPageController like any
 * other desk element, see desk-page.js):
 *
 *  - setup_checklist: what a fresh install still needs (company, email,
 *    backups, 2FA, website, users). Only for whoever administers the system.
 *  - recent_documents: the records the viewer created or edited last, from
 *    the Document History log, filtered by what they may still open.
 *  - desk_greeting: who is looking and for which company.
 *  - system_stats: last backup, website visits, users, recent errors — each
 *    only when its source is installed and the viewer may see it.
 *  - activity_feed: what the rest of the team changed lately.
 */
import { loopar } from '../loopar.js';
import { PermissionManager, SCOPE } from '../auth/PermissionManager.js';
import { getCompany } from '../global/company.js';
import { debugCollector } from '../debug/collector.js';

const SINGLE_VALUES = 'Document Single Values';
const HISTORY_TABLE = 'Document History';

const truthy = (v) => loopar.utils.trueValue(v);

/** A check that can't be read (entity not installed, old schema) is skipped, not failed. */
async function attempt(fn) {
  try {
    return await fn();
  } catch (e) {
    console.warn('[desk-home]', e?.message);
    return undefined;
  }
}

async function singleValues(document, fields) {
  const rows = await loopar.db.qx()(SINGLE_VALUES).select('field', 'value')
    .where({ document }).whereIn('field', fields);
  return Object.fromEntries(rows.map(({ field, value }) => [field, value]));
}

/** Administrators of the system: the Administrator and whoever can edit System Settings. */
export function administersSystem(user = loopar.auth.user()) {
  if (!user) return false;
  return user === 'Administrator' || PermissionManager.can('System Settings', 'update', user);
}

const deskUrl = (entity, action = 'update') => `/desk/${entity}/${action}`;

const clampLimit = (value, fallback) => Math.min(Math.max(parseInt(value, 10) || fallback, 1), 20);

/** Entities whose records the history log tracks today (see document-history.js isTrackable). */
const auditedEntities = () => Object.values(loopar.getRefs() || {})
  .filter(r => r.is_audited === 1 && !r.is_child && !r.is_virtual && r.__NAME__ !== HISTORY_TABLE)
  .map(r => r.__NAME__);

/** Not anyone's work: rows written by an app install/update (see document-history.js). */
const notInstaller = (q) => q.whereNull('metadata').orWhere('metadata', 'not like', '%"source":"installer"%');

/** Display names of users: "First Last", else the user name. */
async function displayNames(names) {
  const list = [...new Set(names.filter(Boolean))];
  if (!list.length) return {};
  const rows = await loopar.db.query('User').whereIn('name', list).select('*');
  return Object.fromEntries(rows.map(r => [
    r.name, [r.first_name, r.last_name].filter(Boolean).join(' ') || r.name,
  ]));
}

/** Titles of `names` of an entity that still exist (not deleted): { name: title }. */
async function liveTitles(ref, names) {
  if (ref.is_single) return Object.fromEntries(names.map(n => [n, n]));
  let qb = loopar.db.qx()(ref.__NAME__).select('name').whereIn('name', names);
  if ((ref.__FIELDS__ || []).includes('__deleted_at__')) qb = qb.whereNull('__deleted_at__');
  const alive = (await qb).map(r => r.name);
  if (!alive.length) return {};
  const doc = await loopar.newDocument(ref.__NAME__);
  const titles = await doc.titlesFor(alive) || {};
  return Object.fromEntries(alive.map(n => [n, titles[n] || n]));
}

/**
 * → { items: [{ key, label, description, done, to, cta }], done, total }
 *   | { denied: true }. An item whose source isn't installed is left out.
 */
export async function setupChecklist(user = loopar.auth.user()) {
  if (!administersSystem(user)) return { denied: true };

  const checks = await Promise.all([
    attempt(async () => {
      if (!loopar.getRef('Company', false)) return undefined;
      const c = await getCompany();
      return {
        key: 'company',
        label: 'Company and logo',
        description: 'Name, logo and regional defaults used across documents and emails.',
        done: !!(c?.company_name && c?.logo),
        to: deskUrl('Company'),
        cta: 'Set up',
      };
    }),
    attempt(async () => {
      const cloud = loopar.cloudVerifier || {};
      const local = await loopar.mail.hasTransport();
      return {
        key: 'email',
        label: 'Outgoing email',
        description: local || !(cloud.url && cloud.token)
          ? 'SMTP for password resets, notifications and forms.'
          : 'Sent through Loopar Cloud for now; add your own SMTP to use your domain.',
        done: !!local || !!(cloud.url && cloud.token),
        to: deskUrl('Email Settings'),
        cta: 'Configure',
      };
    }),
    attempt(async () => {
      if (!loopar.getRef('Backup Settings', false)) return undefined;
      const s = await singleValues('Backup Settings', ['enabled']);
      return {
        key: 'backups',
        label: 'Automatic backups',
        description: 'A scheduled copy of the database (and files) somewhere safe.',
        done: truthy(s.enabled),
        to: deskUrl('Backup Settings'),
        cta: 'Configure',
      };
    }),
    attempt(async () => {
      const row = await loopar.db.query('User').where({ name: user }).select('*').first();
      if (!row || !('mfa_enabled' in row)) return undefined;
      return {
        key: 'mfa',
        label: 'Two-factor authentication',
        description: 'Protect this administrator account with an authenticator app.',
        done: truthy(row.mfa_enabled),
        to: deskUrl('Profile'),
        cta: 'Turn on',
      };
    }),
    attempt(async () => {
      return {
        key: 'website',
        label: 'Website',
        description: 'Install an app with a website (or a template); System Settings lets you pick which one is shown.',
        // Chosen in System Settings, or taken from the first app with a website.
        done: !!loopar.webApp?.name,
        to: deskUrl('System Settings'),
        cta: 'Choose',
      };
    }),
    attempt(async () => {
      const row = await loopar.db.qx()('User').whereNot({ name: 'Administrator' }).whereNot({ name: user })
        .count({ total: 'id' }).first();
      return {
        key: 'users',
        label: 'Invite your team',
        description: 'Add the people who will work in this workspace.',
        done: Number(row?.total || 0) > 0,
        to: deskUrl('User', 'create'),
        cta: 'Invite',
      };
    }),
  ]);

  const items = checks.filter(Boolean);
  return { items, done: items.filter(i => i.done).length, total: items.length };
}

/**
 * The records `user` created or edited last, newest first, one row per
 * record. Records the user can no longer open (permission, deleted) are left
 * out. → { rows: [{ entity, name, title, action, at, single }] }
 */
export async function recentDocuments(data = {}, user = loopar.auth.user()) {
  if (!user || !loopar.getRef(HISTORY_TABLE, false)) return { rows: [] };

  const limit = clampLimit(data.limit, 6);

  // Over-fetch: some will be dropped by permissions or deletion.
  const events = await loopar.db.qx()(HISTORY_TABLE)
    .select('document', 'document_name')
    .max({ at: 'event_at' })
    .where({ user })
    .whereIn('action', ['Created', 'Updated', 'Restored'])
    .whereIn('document', auditedEntities())
    .where(notInstaller)
    .groupBy('document', 'document_name')
    .orderBy('at', 'desc')
    .limit(limit * 3);

  const byEntity = {};
  for (const ev of events) {
    const ref = loopar.getRef(ev.document, false);
    // Same rule as the history writer (document-history.js isTrackable):
    // entities no longer audited (e.g. Page View) left old rows behind.
    if (!ref || ref.is_audited !== 1 || ref.is_child || ref.is_virtual || !ev.document_name) continue;
    if (!PermissionManager.can(ref.__NAME__, ref.is_single ? 'update' : 'view', user)) continue;
    (byEntity[ref.__NAME__] ??= { ref, events: [] }).events.push(ev);
  }

  // Titles of the records that still exist, one query per entity.
  const titles = {};
  await Promise.all(Object.values(byEntity).map(async ({ ref, events: evs }) => {
    titles[ref.__NAME__] = await attempt(() => liveTitles(ref, evs.map(ev => ev.document_name))) || {};
  }));

  const rows = [];
  for (const ev of events) {
    const ref = loopar.getRef(ev.document, false);
    const title = ref && titles[ref.__NAME__]?.[ev.document_name];
    if (!title) continue;
    rows.push({
      entity: ref.__NAME__,
      name: ev.document_name,
      title,
      at: ev.at,
      single: !!ref.is_single,
    });
    if (rows.length >= limit) break;
  }

  return { rows };
}

/** → { name, company } for the greeting; the time of day is the viewer's own. */
export async function deskGreeting(user = loopar.auth.user()) {
  if (!user) return { denied: true };
  const row = await attempt(() => loopar.db.query('User').where({ name: user }).select('*').first());
  const company = await attempt(() => getCompany());
  return {
    // First name, as people greet each other; the user name when there's none.
    name: row?.first_name || user,
    company: company?.company_name || null,
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const isoDay = (date) => date.toISOString().slice(0, 10);

/**
 * → { items: [{ key, label, value, kind, hint, tone, to }] }. `kind`:
 * "number" | "time" (value is a date the client shows as "6 hours ago").
 */
export async function systemStats(user = loopar.auth.user()) {
  if (!user) return { denied: true };
  const admin = administersSystem(user);

  const stats = await Promise.all([
    admin && attempt(async () => {
      if (!loopar.getRef('Backup Settings', false)) return undefined;
      const s = await singleValues('Backup Settings', ['enabled', 'last_backup_at', 'last_backup_status']);
      const at = s.last_backup_at ? new Date(String(s.last_backup_at).replace(' ', 'T') + 'Z') : null;
      const stale = !at || Number.isNaN(at.getTime()) || Date.now() - at.getTime() > 2 * DAY_MS;
      const failed = s.last_backup_status && s.last_backup_status !== 'Success';
      return {
        key: 'backup',
        label: 'Last backup',
        value: at && !Number.isNaN(at.getTime()) ? at.toISOString() : null,
        kind: 'time',
        hint: !at ? (truthy(s.enabled) ? 'Waiting for the first run' : 'Not scheduled') : failed ? s.last_backup_status : truthy(s.enabled) ? 'Automatic' : 'Manual only',
        tone: failed || stale ? 'warning' : 'default',
        to: '/desk/Backups/view',
      };
    }),
    attempt(async () => {
      const ref = loopar.getRef('Page View', false);
      if (!ref || !PermissionManager.can(ref.__NAME__, 'list', user)) return undefined;
      const from = isoDay(new Date(Date.now() - 6 * DAY_MS));
      const row = await loopar.db.qx()(ref.__NAME__)
        .where('workspace', 'web').andWhere('visit_date', '>=', from)
        .andWhere(q => q.whereNot('is_internal', 1).orWhereNull('is_internal'))
        .count({ total: 'id' }).first();
      return {
        key: 'visits',
        label: 'Website visits',
        value: Number(row?.total || 0),
        kind: 'number',
        hint: 'Last 7 days',
        tone: 'default',
        to: '/desk/Analytics Dashboard/view',
      };
    }),
    attempt(async () => {
      if (!PermissionManager.can('User', 'list', user)) return undefined;
      const row = await loopar.db.qx()('User')
        .where(q => q.whereNull('disabled').orWhereNot('disabled', 1))
        .count({ total: 'id' }).first();
      return {
        key: 'users',
        label: 'Users',
        value: Number(row?.total || 0),
        kind: 'number',
        hint: 'Enabled accounts',
        tone: 'default',
        to: deskUrl('User', 'list'),
      };
    }),
    admin && attempt(async () => {
      if (!debugCollector.enabled) return undefined;
      const since = new Date(Date.now() - DAY_MS).toISOString();
      const total = debugCollector.errors(loopar.requestTenantId, { level: 'error', since }).total;
      return {
        key: 'errors',
        label: 'Errors',
        value: total,
        kind: 'number',
        hint: 'Last 24 hours',
        tone: total > 0 ? 'warning' : 'default',
        to: '/desk/Debugger/view',
      };
    }),
  ]);

  return { items: stats.filter(Boolean) };
}

/**
 * What the rest of the team changed lately, on records the viewer may see
 * entirely (list scope "all": an own-scope viewer would learn about records
 * they can't open). → { rows: [{ user, user_name, action, entity, name, title, at, single, live }] }
 */
export async function activityFeed(data = {}, user = loopar.auth.user()) {
  if (!user || !loopar.getRef(HISTORY_TABLE, false)) return { rows: [] };
  const limit = clampLimit(data.limit, 8);

  const events = await loopar.db.qx()(HISTORY_TABLE)
    .select('document', 'document_name', 'action', 'user', 'event_at')
    .whereNotNull('user')
    .whereNot({ user })
    .whereIn('action', ['Created', 'Updated', 'Deleted', 'Restored'])
    .whereIn('document', auditedEntities())
    .where(notInstaller)
    .orderBy('event_at', 'desc')
    .limit(limit * 4);

  const visible = [];
  const byEntity = {};
  for (const ev of events) {
    const ref = loopar.getRef(ev.document, false);
    // Same rule as the history writer (document-history.js isTrackable):
    // entities no longer audited (e.g. Page View) left old rows behind.
    if (!ref || ref.is_audited !== 1 || ref.is_child || ref.is_virtual || !ev.document_name) continue;
    if (PermissionManager.scope(ref.__NAME__, 'list', user) !== SCOPE.ALL) continue;
    // One line per record: its latest event.
    if (visible.some(v => v.document === ev.document && v.document_name === ev.document_name)) continue;
    visible.push(ev);
    (byEntity[ref.__NAME__] ??= { ref, names: [] }).names.push(ev.document_name);
    if (visible.length >= limit) break;
  }

  const titles = {};
  await Promise.all(Object.values(byEntity).map(async ({ ref, names }) => {
    titles[ref.__NAME__] = await attempt(() => liveTitles(ref, names)) || {};
  }));
  const people = await attempt(() => displayNames(visible.map(v => v.user))) || {};

  return {
    rows: visible.map(ev => {
      const ref = loopar.getRef(ev.document, false);
      const live = ev.document_name in (titles[ref.__NAME__] || {});
      return {
        user: ev.user,
        user_name: people[ev.user] || ev.user,
        action: ev.action,
        entity: ref.__NAME__,
        name: ev.document_name,
        title: titles[ref.__NAME__]?.[ev.document_name] || ev.document_name,
        at: ev.event_at,
        single: !!ref.is_single,
        live: live && ev.action !== 'Deleted',
      };
    }),
  };
}
