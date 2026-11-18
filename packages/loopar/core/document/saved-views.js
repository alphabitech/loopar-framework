'use strict';

import { loopar } from '../loopar.js';
import { LIST_CONTROL_PARAMS } from './list-state.js';
import { REPORT_PARAMS, parseReportSpec } from '../global/list-report.js';
import { parseSort } from '../global/list-settings.js';
import { toCsv, csvFileName } from '../global/csv.js';

/**
 * Saved views of a list: a name for what its URL holds (filters, sort,
 * report) plus the view type. One `Saved View` record each; private to its
 * user, or `shared` with everyone who can open the list. A tenant whose app
 * doesn't have the entity yet simply has none.
 */
export const SAVED_VIEW_ENTITY = 'Saved View';
export const SAVED_VIEW_TYPES = Object.freeze(['List', 'Grid', 'Kanban', 'Calendar', 'Report']);
export const EMAIL_SCHEDULES = Object.freeze(['none', 'daily', 'weekly', 'monthly']);
const MAX_RECIPIENTS = 10;
const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
/** Scheduled emails go out once the day has started for whoever reads them. */
const SEND_FROM_HOUR = 6;
/** Rows a scheduled email shows inline; the attached CSV holds them all. */
const EMAIL_PREVIEW_ROWS = 40;
const MAX_TITLE = 80;
const MAX_QUERY = 4000;
const MAX_VIEWS = 200;

const installed = () => !!loopar.getRef(SAVED_VIEW_ENTITY, false);
const table = () => loopar.db.qx()(SAVED_VIEW_ENTITY);
const truthy = (value) => [1, '1', true, 'true'].includes(value);

async function signedUser(user) {
  if (!user || user === 'Guest') loopar.throw({ code: 401, message: 'You must be logged in to use saved views.' });
  return user;
}

/** Whoever may list an entity may read and keep views of its list. */
async function assertCanList(entity, user) {
  const { PermissionManager } = await import('../auth/PermissionManager.js');
  if (!PermissionManager.scope(entity, 'list', user)) {
    loopar.throw({ code: 403, message: 'You do not have permission to perform this action' });
  }
}

/**
 * The part of a list URL a view keeps: its filters, sort and report. Page and
 * transport parameters are dropped; so is anything that is not a plain pair.
 */
export function savedViewQuery(query) {
  const report = new Set(REPORT_PARAMS);
  const out = new URLSearchParams();
  for (const [key, value] of new URLSearchParams(String(query ?? '').replace(/^\?/, ''))) {
    if (LIST_CONTROL_PARAMS.has(key) && key !== 'sort' && !report.has(key)) continue;
    if (!key || value === '' || out.has(key)) continue;
    out.set(key, value);
  }
  return out.toString().slice(0, MAX_QUERY);
}

const present = (row, user) => {
  const mine = row.owner_user === user;
  return {
    name: row.name,
    title: row.title,
    query: row.query || '',
    view_type: SAVED_VIEW_TYPES.includes(row.view_type) ? row.view_type : 'List',
    shared: truthy(row.shared),
    mine,
    // The schedule is its owner's business: recipients are not shown to others.
    ...(mine ? {
      email_schedule: EMAIL_SCHEDULES.includes(row.email_schedule) ? row.email_schedule : 'none',
      email_to: row.email_to || '',
    } : {}),
  };
};

/** Views of the list of `entity` the user sees: their own first, then the shared ones, by title. */
export async function listSavedViews(entity, user = loopar.auth?.user?.()) {
  await signedUser(user);
  if (!installed()) return [];
  await assertCanList(entity, user);

  const rows = await table()
    .select('*')
    .where({ target_entity: entity })
    .whereNull('__deleted_at__')
    .where((w) => w.where({ owner_user: user }).orWhere({ shared: 1 }))
    .limit(MAX_VIEWS);

  return rows.map((row) => present(row, user)).sort((a, b) =>
    (Number(b.mine) - Number(a.mine)) || String(a.title).localeCompare(String(b.title), undefined, { sensitivity: 'base' }));
}

/**
 * Saves a view of the list of `entity` for the user. `name` replaces one of
 * their own views; without it, a view of theirs with the same title is
 * replaced, otherwise a new one is created. → the saved view.
 */
export async function writeSavedView(entity, { name = null, title, query, view_type, shared } = {}, user = loopar.auth?.user?.()) {
  await signedUser(user);
  if (!installed()) loopar.throw({ code: 404, message: 'Saved views are not available: update the loopar app.' });
  await assertCanList(entity, user);

  const cleanTitle = String(title ?? '').trim().replace(/\s+/g, ' ').slice(0, MAX_TITLE);
  if (!cleanTitle) loopar.throw({ code: 400, message: 'A saved view needs a title.' });

  const values = {
    title: cleanTitle,
    query: savedViewQuery(query),
    view_type: SAVED_VIEW_TYPES.includes(view_type) ? view_type : 'List',
    shared: truthy(shared) ? 1 : 0,
  };

  const mine = () => table().where({ target_entity: entity, owner_user: user }).whereNull('__deleted_at__');
  const existing = name
    ? await mine().where({ name: String(name) }).first('id', 'name')
    : await mine().where({ title: cleanTitle }).first('id', 'name');
  if (name && !existing) loopar.throw({ code: 404, message: 'Saved view not found.' });

  if (existing) {
    await table().where({ id: existing.id }).update(values);
    return present({ ...values, name: existing.name, owner_user: user }, user);
  }

  if (Number((await mine().count({ count: 'id' }).first())?.count || 0) >= MAX_VIEWS) {
    loopar.throw({ code: 400, message: 'Too many saved views for this list: remove some first.' });
  }
  const newName = loopar.getUniqueKey();
  await table().insert({ name: newName, owner_user: user, target_entity: entity, ...values });
  return present({ ...values, name: newName, owner_user: user }, user);
}

/** Removes one of the user's own views (Administrator: anyone's). */
export async function deleteSavedView(name, user = loopar.auth?.user?.()) {
  await signedUser(user);
  if (!installed() || !name) loopar.throw({ code: 404, message: 'Saved view not found.' });

  const row = await table().where({ name }).whereNull('__deleted_at__').first('id', 'owner_user');
  if (!row || (row.owner_user !== user && user !== 'Administrator')) {
    loopar.throw({ code: 404, message: 'Saved view not found.' });
  }
  await table().where({ id: row.id }).delete();
}

// ---- Scheduled emails ----------------------------------------------------------

const escapeHTML = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const localDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** `"a@x.com, b@y.com"` → valid, distinct addresses (at most MAX_RECIPIENTS). */
export function emailRecipients(text) {
  const out = [];
  for (const part of String(text ?? '').split(/[,;\s]+/)) {
    const email = part.trim().toLowerCase();
    if (EMAIL.test(email) && !out.includes(email)) out.push(email);
    if (out.length === MAX_RECIPIENTS) break;
  }
  return out;
}

/** Whether a view on `schedule`, last sent on `lastDay`, is due at `now` (server-local time). */
export function scheduledEmailDue(schedule, lastDay, now = new Date()) {
  if (!['daily', 'weekly', 'monthly'].includes(schedule)) return false;
  if (now.getHours() < SEND_FROM_HOUR || lastDay === localDay(now)) return false;
  if (schedule === 'weekly') return now.getDay() === 1;
  if (schedule === 'monthly') return now.getDate() === 1;
  return true;
}

/**
 * Sets (or clears, with "none") the email schedule of one of the user's own
 * views. Sending a list by email is an export: it needs the `export` grant
 * over every record (no 'own' / 'customer' narrowing — the email is built
 * outside a request, where there is no user to narrow to). Without
 * recipients it goes to the user's own address. → the saved view.
 */
export async function scheduleSavedView(name, { schedule, to } = {}, user = loopar.auth?.user?.()) {
  await signedUser(user);
  if (!installed()) loopar.throw({ code: 404, message: 'Saved views are not available: update the loopar app.' });

  const row = await table().where({ name: String(name ?? ''), owner_user: user }).whereNull('__deleted_at__').first();
  if (!row) loopar.throw({ code: 404, message: 'Saved view not found.' });

  const email_schedule = EMAIL_SCHEDULES.includes(schedule) ? schedule : 'none';
  let recipients = emailRecipients(to);

  if (email_schedule !== 'none') {
    if (!(await mayEmail(row.target_entity, user))) {
      loopar.throw({ code: 403, message: 'Sending a list by email needs permission to export all of its records.' });
    }
    if (!recipients.length) {
      const own = await loopar.db.getValue('User', 'email', user).catch(() => null);
      recipients = emailRecipients(own || user);
    }
    if (!recipients.length) loopar.throw({ code: 400, message: 'Add at least one email address.' });
  }

  const values = { email_schedule, email_to: recipients.join(', ') };
  await table().where({ id: row.id }).update(values);
  return present({ ...row, ...values }, user);
}

/** The owner may list and export every record of the entity. */
async function mayEmail(entity, user) {
  const { PermissionManager, SCOPE } = await import('../auth/PermissionManager.js');
  return PermissionManager.scope(entity, 'list', user) === SCOPE.ALL && PermissionManager.scope(entity, 'export', user) === SCOPE.ALL;
}

/** What a saved view holds, as a table: `{ header, rows, truncated }` — its report, or its list. */
export async function savedViewTable(view) {
  const params = new URLSearchParams(view.query || '');
  const query = Object.fromEntries(params);
  const q = {};
  for (const [key, value] of params) {
    if (!LIST_CONTROL_PARAMS.has(key)) q[key] = value;
  }
  const filters = Object.keys(q).length ? q : null;
  const document = await loopar.newDocument(view.target_entity);

  const spec = view.view_type === 'Report' ? parseReportSpec(query) : null;
  if (!spec) {
    const sort = parseSort(query.sort);
    return await document.exportRows({ q: filters, sort: sort.length ? sort : null });
  }

  const report = await document.reportData({ groups: spec.groups, values: spec.values, q: filters });
  const number = (value) => (value === null || value === undefined ? '' : Math.round(Number(value) * 100) / 100);
  const line = (labels, entry) => [...labels, entry.count, ...report.values.map((v) => number(entry.values?.[v.key]))];
  return {
    header: [
      ...report.groups.map((g) => (g.grain ? `${g.label} (${g.grain})` : g.label)),
      'Records',
      ...report.values.map((v) => `${v.fn} ${v.label}`),
    ],
    rows: [
      ...report.rows.map((row) => line(row.keys.map((key, i) => row.labels?.[i] ?? key), row)),
      ...(report.groups.length ? [line(['Total', ...report.groups.slice(1).map(() => '')], report.totals)] : []),
    ],
    truncated: report.truncated,
  };
}

/**
 * Scheduled job: emails every saved view whose schedule is due — a short
 * table in the body and the whole of it attached as CSV. A view whose owner
 * no longer may export the list is skipped. → summary for the job log.
 */
export async function sendScheduledViews(now = new Date()) {
  if (!installed()) return 'Saved views are not installed';

  let rows;
  try {
    rows = await table().select('*').whereIn('email_schedule', ['daily', 'weekly', 'monthly']).whereNull('__deleted_at__');
  } catch (e) {
    return `Saved views have no schedule yet: update the loopar app (${e?.message || e})`;
  }

  const today = localDay(now);
  let sent = 0, failed = 0, skipped = 0;

  for (const view of rows) {
    if (!scheduledEmailDue(view.email_schedule, view.last_sent_on, now)) continue;
    const to = emailRecipients(view.email_to);

    try {
      if (!to.length || !loopar.getRef(view.target_entity, false) || !(await mayEmail(view.target_entity, view.owner_user))) {
        skipped++;
        continue;
      }

      const { header, rows: lines, truncated } = await savedViewTable(view);
      const cell = (value, tag = 'td') => `<${tag} style="padding:4px 8px;border-bottom:1px solid #e5e5e5;text-align:left">${escapeHTML(value)}</${tag}>`;
      const html = `<p><strong>${escapeHTML(view.title)}</strong> · ${escapeHTML(view.target_entity)} · ${today}</p>`
        + (lines.length
          ? `<table style="border-collapse:collapse;font-size:13px"><thead><tr>${header.map((h) => cell(h, 'th')).join('')}</tr></thead>`
            + `<tbody>${lines.slice(0, EMAIL_PREVIEW_ROWS).map((line) => `<tr>${line.map((value) => cell(value)).join('')}</tr>`).join('')}</tbody></table>`
          : '<p>No records match this view today.</p>')
        + (lines.length > EMAIL_PREVIEW_ROWS ? `<p>Showing ${EMAIL_PREVIEW_ROWS} of ${lines.length} rows; the attached file has them all.</p>` : '')
        + (truncated ? '<p>The view has more rows than one file holds; add filters to see the rest.</p>' : '');

      await loopar.mail.send({
        to,
        subject: `${view.title} — ${view.target_entity} (${today})`,
        html,
        attachments: [{ filename: csvFileName(`${view.target_entity} ${view.title}`, today), content: toCsv([header, ...lines]) }],
      });
      // Plain column write: sending is not an edit of the view.
      await table().where({ id: view.id }).update({ last_sent_on: today });
      sent++;
    } catch (e) {
      // Not marked as sent: the next run tries again while the day lasts.
      console.error(`[saved-views] email of "${view.title}" (${view.target_entity}) failed:`, e?.message || e);
      failed++;
    }
  }

  return [`${sent} view(s) sent`, failed && `${failed} failed`, skipped && `${skipped} skipped`].filter(Boolean).join('; ');
}
