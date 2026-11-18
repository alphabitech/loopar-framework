'use strict'

import { loopar, DOC_STATUS, coerceDocStatus } from "loopar";
import CoreController from './core-controller.js';
import { workspaceServesWebPages } from '../global/router-utils.js';
import { printPayload } from '../document/print-format.js';
import { renameEntity } from '../document/entity-rename.js';
import { readRuntimeMode } from '../server/runtime-mode.js';
import { applyTransition, workflowFor } from '../document/workflow.js';
import { policyMapOf, currentActor } from '../auth/field-access.js';
import { hasFreshStepUp, clearStepUp, STEP_UP_REQUIRED_CODE } from '../auth/step-up.js';
import { canWriteFromInput, WRITE_POLICY } from '../global/field-policy.js';
import { parseReportSpec } from '../global/list-report.js';
import { toCsv, csvFileName } from '../global/csv.js';
import { importRecords } from '../document/list-import.js';
import { bulkUpdateRecords, bulkTransitionRecords } from '../document/list-bulk.js';
import { titleize } from "inflection";

const HISTORY_TABLE = 'Document History';
const COMMENT_TABLE = 'Comment';

const AUDIT_FIELDS = ['name', 'user', 'action', 'event_at', 'diff', 'metadata'];
/** Feed items (audit events + root comments) per page, and the most one request may ask for. */
const FEED_PAGE = 20;
const FEED_PAGE_MAX = 200;
/** Reply levels followed under a comment. */
const THREAD_DEPTH_MAX = 50;
const COMMENT_FIELDS = ['name', 'document', 'document_name', 'parent', 'user', 'guest_name', 'guest_email', 'comment', 'status', 'created_at'];

const MAX_COMMENT_LEN = 2000;

function commenterName(row) {
  return row.user || row.guest_name || 'Guest';
}

export default class BaseController extends CoreController {
  defaultAction = 'list';
  hasSidebar = true;
  static enabledActions = []

  /**
   * The list page. Its views (List, Grid, Board, Calendar, Report) are the
   * same page seen another way; the ones that need data of another shape read
   * it from their own action: `board`, `calendar`, `report` (authorized by
   * the `list` grant, auth/permission-aliases.js). `export` and `import` move
   * the list's records out of and into a file, each with its own grant.
   */
  async actionList() {
    // Filters come from the URL query (document/list-state.js), empties already dropped.
    const data = loopar.getQ(this.document);

    // Scope 'own' is applied by the model (BaseDocument.getList via
    // auth/record-scope.js), so a controller overriding this action can't skip it.
    const list = await loopar.getList(this.document, { data, q: (data && Object.keys(data).length > 0) ? data : null });

    if(this.preloaded == true) {
      return {
        instance: this.getInstance(),
        rows: list.rows,
        pagination: list.pagination,
        q: list.q || {}
      }
    }

    return await this.render(list);
  }

  /**
   * "New" from a day of the calendar: `create?<start field>=…&<end field>=…`
   * starts the record on those dates (the entity's calendar fields only).
   */
  #prefillDates(document) {
    const calendar = document.__ENTITY__?.__REF__?.__CALENDAR__ || loopar.getRef(document.__ENTITY__?.name, false)?.__CALENDAR__;
    if (!calendar) return;
    const value = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/;
    for (const name of [calendar.start, calendar.end, calendar.allDay].filter(Boolean)) {
      const field = document.fields?.[name];
      const input = String(this.query?.[name] ?? '').trim();
      if (!field || !input) continue;
      if (loopar.utils.trueValue(field.readonly) || field.formula) continue;
      if (name === calendar.allDay) field.value = ['1', 'true'].includes(input) ? 1 : 0;
      else if (value.test(input)) field.value = input.replace('T', ' ');
    }
  }

  #prefill(document, text) {
    const fieldName = String(document.titleFields?.() || 'name').split(',').map(f => f.trim()).find(Boolean);
    const field = fieldName && document.fields?.[fieldName];
    if (!field || field.value) return;
    if (![undefined, null, '', 'editable'].includes(field.write_policy)) return;
    if (loopar.utils.trueValue(field.readonly) || field.formula) return;
    field.value = text.slice(0, 255);
  }

  async actionCreate() {
    // Field write policy, layer A: applied by newDocument itself (request input).
    const document = await loopar.newDocument(this.document, this.data);

    // "Create «text»" from a connection: the text typed in its search starts
    // the new record's first title field (when the user may write it).
    if (!this.hasData() && this.query?.prefill) this.#prefill(document, String(this.query.prefill));
    if (!this.hasData()) this.#prefillDates(document);

    if (document.__ENTITY__.is_single) {
      return loopar.throw({
        code: 404,
        message: "This document is single, you can't create new"
      });
    }

    if (this.hasData()) {
      await document.save();
      return {
        ...this.redirect('update?name=' + document.name, {
          notify: `${document.__ENTITY__.name} ${document.name} created successfully`,
        }),
        name: document.name,
      };
    } else {
      if(this.preloaded == true) {
        return await document.values();
      }
      
      Object.assign(this.response, await document.__meta__());
      return await this.render(this.response);
    }
  }

  /** The list's filters (URL query) for a data action, without that action's own parameters. */
  #listSearch(exclude = []) {
    const q = { ...loopar.getQ(this.document, { exclude }) };
    return Object.keys(q).length ? q : null;
  }

  /**
   * Data actions answer the app (RPC). Opened as a page they lead to the
   * list, keeping the query (filters, report).
   */
  #listPage() {
    if (this.method === "POST") return null;
    const query = new URLSearchParams(this.req?._parsedUrl?.query || "").toString();
    return this.redirect(`list${query ? `?${query}` : ""}`);
  }

  /**
   * Board view (data): one Kanban column — `{Entity}/board?board=<state>&page=N`.
   * Same permission, search and owner scope as the list.
   */
  async actionBoard() {
    const page = this.#listPage();
    if (page) return page;

    const workflow = await workflowFor(this.document);
    if (!workflow) loopar.throw(`${this.document} has no active workflow.`);
    const document = await loopar.newDocument(this.document);
    return await document.getBoardColumn({
      field: workflow.field,
      state: String(this.query?.board ?? ""),
      q: this.#listSearch(["board"]),
      page: parseInt(this.query?.page, 10) || 1,
    });
  }

  /**
   * Calendar view (data): `{Entity}/calendar?cal_from=&cal_to=` (the records
   * of those days) or `?calendar=unscheduled&page=N`. Same permission, search
   * and owner scope as the list.
   */
  async actionCalendar() {
    const page = this.#listPage();
    if (page) return page;

    const document = await loopar.newDocument(this.document);
    return await document.calendarRows({
      unscheduled: String(this.query?.calendar) === "unscheduled",
      from: String(this.query?.cal_from || ""),
      to: String(this.query?.cal_to || ""),
      q: this.#listSearch(["calendar", "cal_from", "cal_to"]),
      page: parseInt(this.query?.page, 10) || 1,
    });
  }

  /**
   * Report view (data): the list's records grouped and aggregated —
   * `{Entity}/report?report=status,due_date.month&report_values=sum.total`
   * (global/list-report.js) plus the list's filters. Same permission, search
   * and owner scope as the list.
   */
  async actionReport() {
    const page = this.#listPage();
    if (page) return page;

    const spec = parseReportSpec(this.query) || { groups: [], values: [] };
    const document = await loopar.newDocument(this.document);
    return await document.reportData({ groups: spec.groups, values: spec.values, q: this.#listSearch() });
  }

  /**
   * Export: the list's records as a CSV file — `{Entity}/export` with the
   * list's filters and sort in the query and, in the body, `fields` (columns,
   * in order; default: the list's) and `names` (only those records; default:
   * every record the filters match). Needs the `export` grant; an 'own' scope
   * narrows it to the user's records.
   *
   * → { filename, csv, rows, truncated }
   */
  async actionExport() {
    const page = this.#listPage();
    if (page) return page;

    const list = (value) => {
      const parsed = Array.isArray(value) ? value : (loopar.utils.isJSON(value) ? JSON.parse(value) : null);
      return Array.isArray(parsed) && parsed.length ? parsed.map(String) : null;
    };

    const document = await loopar.newDocument(this.document);
    const { header, rows, truncated } = await document.exportRows({
      q: this.#listSearch(),
      fields: list(this.body?.fields),
      names: list(this.body?.names),
    });

    const now = new Date();
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    return {
      filename: csvFileName(this.document, day),
      csv: toCsv([header, ...rows]),
      rows: rows.length,
      truncated,
    };
  }

  /**
   * Import: records from a file into the list — `{Entity}/import` with, in
   * the body, `records` (`[{ field: cell text }]`, the file's rows already
   * mapped to fields), `mode` ("insert" | "upsert" by `name`) and `dry_run`
   * (validate only). Needs the `import` grant, plus `create` / `update` for
   * what the rows do. Every record is saved through its document.
   *
   * → { total, created, updated, failed, issues: [{ row, message }], dry_run }
   */
  async actionImport() {
    const page = this.#listPage();
    if (page) return page;

    const raw = this.body?.records;
    const records = Array.isArray(raw) ? raw : (loopar.utils.isJSON(raw) ? JSON.parse(raw) : []);
    return await importRecords(this.document, {
      records,
      mode: String(this.body?.mode || 'insert'),
      dryRun: [1, '1', true, 'true'].includes(this.body?.dry_run),
    });
  }

  /**
   * Workflow transition: `{Entity}/transition?name=X` with `{ action, values }`.
   * Needs the `transition` grant on the entity; the workflow narrows it per
   * transition (allowed roles) and `values` may only fill required fields.
   */
  async actionTransition() {
    const data = this.data || {};
    const values = typeof data.values === 'string' ? loopar.utils.JSONparse(data.values, {}) : (data.values || {});
    const document = await loopar.getDocument(this.document, this.query.name);
    // Data endpoint: no `message` key, so the client keeps the payload.
    return await applyTransition(document, data.action, values);
  }

  async actionUpdate(document) {
    // Field write policy, layer A: getDocument filters the request input itself
    // (protected/system/readonly/create_only fields keep their stored value).
    document ??= await loopar.getDocument(this.document, this.query.name, this.hasData() ? this.data : null);

    if (this.hasData()) {
      const Entity = document.__ENTITY__;
      const isSingle = Entity.is_single;
      await document.save();

      return await this.success(
        `${(Entity.name === "Entity") ? document.type || "Entity" : (isSingle ? "" : Entity.name)} ${isSingle ? Entity.name : document.name} saved successfully`, { name: document.name, ...document.versionStamp() }
      );
    } else {
      if(this.preloaded == true) {
        // The client reuses the cached meta of the first record it opened
        // with this URL. Meta that depends on the record travels with the
        // data: the workflow (state + available transitions) and, for
        // records whose fields lock per record (contact forms), the structure.
        const recordMeta = (await workflowFor(this.document)) || typeof document.lockedFields === 'function'
          ? await document.__meta__()
          : null;
        return {
          instance: this.getInstance(),
          // The URL instance ignores ?name=, so the cached meta belongs to the
          // FIRST record opened here: the record's identity must travel with
          // the data (AppBar subtitle, <title>, history, rename, print/edit links).
          name: document.name,
          meta: { title: titleize(String(document.name ?? this.document)), action: this.action },
          data: { ...await document.values(), ...document.versionStamp() },
          linkTitles: await document.linkTitles(),
          ...(recordMeta?.workflow ? { workflow: recordMeta.workflow } : {}),
          ...(recordMeta && typeof document.lockedFields === 'function' ? { Entity: recordMeta.Entity } : {}),
        }
      }
      // linkTitles: selects show the linked record's title (not its code) before opening.
      return await this.render({ ...await document.__meta__(), linkTitles: await document.linkTitles(), ...this.response || {} });
    }
  }

  /**
   * POST <Entity>/changeProtected?name=<record>   body: { field, value, confirm? }
   *
   * The ONLY way a `protected` field (write_policy) changes from the client —
   * the regular save drops it (field-access, layer A) and refuses it (layer B).
   * Requires: `update` permission on the record (AuthController maps this
   * action onto it), the field's write_roles, and a fresh re-authentication
   * (Auth/reauthenticate → otherwise 428). An entity can take the change over
   * (User: email confirmation link, password + confirmation) by defining on its
   * Document `async changeProtectedField(field, value, { confirm, actor })`;
   * whatever it returns (message string or { message }) ends the request.
   */
  /** The record a protected change applies to. Proxies (Profile) override it. */
  async protectedChangeTarget() {
    return await loopar.getDocument(this.document, this.query.name ?? this.name);
  }

  async actionChangeProtected() {
    if (!this.hasData()) loopar.throw({ code: 400, message: 'Nothing to change.' });

    const { field, value, confirm } = this.data;
    const map = policyMapOf(this.document);
    const rule = field ? map[String(field)] : null;
    if (!rule || rule.policy !== WRITE_POLICY.PROTECTED) {
      loopar.throw({ code: 400, message: `"${field}" is not a protected field.` });
    }

    const actor = await currentActor(map);
    const byRoles = canWriteFromInput({ ...rule, policy: WRITE_POLICY.EDITABLE, name: String(field) }, { op: 'update', actor });
    if (!byRoles.allowed) loopar.throw({ code: 403, message: 'You do not have permission to change this field.' });

    const user = loopar.auth.user();
    if (!hasFreshStepUp(user)) {
      loopar.throw({ code: STEP_UP_REQUIRED_CODE, title: 'Confirm your identity', message: 'Enter your password to change this field.' });
    }

    const document = await this.protectedChangeTarget();

    let result = null;
    if (typeof document.changeProtectedField === 'function') {
      result = await document.changeProtectedField(String(field), value, { confirm, actor: user });
    }

    if (result === null || result === undefined) {
      document.authorize(field);
      document[field] = value;
      if (rule.element === 'password' && document.fields?.confirm_password && field !== 'confirm_password') {
        document.authorize('confirm_password');
        document.confirm_password = confirm ?? value;
      }
      await document.save();
      result = 'Updated successfully';
    }

    // One re-authentication = one change: the proof is consumed here.
    clearStepUp();
    console.info(`[field-policy] protected change ${this.document}/${document.name ?? ''}.${field} by ${user}`);
    const message = typeof result === 'string' ? result : (result?.message || 'Updated successfully');
    return this.success(message, { name: document.name });
  }

  /**
   * Read-only rendering of one record: the form with every field shown as its
   * value (`Document.readOnly`). Link titles let selects show titles, not names.
   * A GET to `update` without the update permission lands here too
   * (AuthController downgrades it when the user may view).
   */
  async actionView() {
    const document = await loopar.getDocument(this.document, this.name);
    // Records only: pages, views, reports and singles render through `view` too.
    const readOnly = !loopar.entityIsSingle(document.__ENTITY__ || {});
    return await this.render(document, { linkTitles: await document.linkTitles(), readOnly });
  }

  /**
   * Printable rendering of one record (`/desk/<Entity>/print?name=X`).
   * `print` is its own permission (ActionScanner derives it from this method),
   * and a grant with scope 'own' is enforced by AuthController like any other
   * record action. `?format=<name>|standard` picks the format (default: the
   * entity's default Print Format). The client mounts the `print` entry: a
   * designed format wins, then the app's `client/<entity>-print.jsx`, then
   * the automatic format.
   */
  async actionPrint() {
    const document = await loopar.getDocument(this.document, this.name);
    return await this.render(document, {
      linkTitles: await document.linkTitles(),
      print: await printPayload(this.document, { requested: this.query?.format }),
    });
  }

  /**
   * Rename an entity/page/form… (a record of Entity or of a builder type):
   * files, this tenant's database and references, recorded for the other
   * tenants (see core/document/entity-rename.js). `dry_run` returns the plan.
   * Development only: in production the files come from the deploy.
   */
  async actionRename() {
    const isMeta = this.document === 'Entity' || !!loopar.getType(this.document);
    if (!isMeta) loopar.throw(`${this.document} records can't be renamed this way.`);
    if (readRuntimeMode() === 'production') {
      loopar.throw("Renaming changes the app's files: rename in development and deploy.");
    }

    const { name, new_name, dry_run } = this.data || {};
    const ref = loopar.getRef(name);
    if (!ref || (ref.__ENTITY__ || 'Entity') !== this.document) {
      loopar.throw({ code: 404, message: `${this.document} "${name}" not found.` });
    }

    // No `message` key: the client would collapse the payload to it.
    const rename = await renameEntity(name, new_name, { dryRun: !!Number(dry_run) || dry_run === true });
    return { rename };
  }

  async actionDelete() {
    const document = await loopar.getDocument(this.document, this.name);
    await document.delete();

    return this.redirect('list', { notify: `${this.document} ${this.name} deleted successfully` });
  }

  /** The `names` a bulk action targets (body: an array, or its JSON). */
  #bulkNames() {
    const raw = this.body?.names;
    return Array.isArray(raw) ? raw : (loopar.utils.isJSON(raw) ? JSON.parse(raw) : []);
  }

  /**
   * Bulk edit: `{Entity}/bulkUpdate` with `{ names, field, value }` — sets one
   * field on every selected record, through its document. Authorized by the
   * `update` grant (an 'own' scope is checked per record).
   *
   * → { total, done, failed, issues: [{ name, message }] }
   */
  async actionBulkUpdate() {
    const page = this.#listPage();
    if (page) return page;
    return await bulkUpdateRecords(this.document, {
      names: this.#bulkNames(),
      field: String(this.body?.field ?? ''),
      value: this.body?.value,
    });
  }

  /**
   * Bulk workflow transition: `{Entity}/bulkTransition` with `{ names, action }`.
   * Authorized by the `transition` grant; the workflow narrows it per record.
   *
   * → { total, done, failed, issues: [{ name, message }] }
   */
  async actionBulkTransition() {
    const page = this.#listPage();
    if (page) return page;
    return await bulkTransitionRecords(this.document, { names: this.#bulkNames(), action: String(this.body?.action ?? '') });
  }

  async actionBulkDelete() {
    const raw = this.body?.names;
    const names = Array.isArray(raw)
      ? raw
      : (loopar.utils.isJSON(raw) ? JSON.parse(raw) : []);

    if (Array.isArray(names)) {
      for (const name of names) {
        const document = await loopar.getDocument(this.document, name);
        await document.delete();
      }
    }

    return this.success(`Documents ${names.join(', ')} deleted successfully`, { name: names.join(', ') });
  }

  // ---- Document history & comments ---------------------------------------
  // Inherited by every entity controller, gated by the entity's
  // `enable_history` / `enable_comments` flags. Audit lives in the immutable
  // "Document History" log; comments live in the threaded "Comment" entity.
  // `this.documentHistory` lets a controller anchor to a different owner
  // (e.g. pages anchor to "Page Builder"); defaults to this.document.

  commentTarget() {
    return this.documentHistory || this.document;
  }

  /**
   * One page of a record's feed, newest first. A feed item is an audit event
   * or a root comment on the record, and it comes with its whole thread: the
   * comments on the event (when includeEvents) and every reply. Rows share a
   * shape (event_at, action, display user); `parent` lets the client build
   * the tree.
   *
   * Each table pages by its own id (`cursor` = the last id served from it),
   * so activity added while reading never shifts or repeats a page.
   *
   * @returns {{ rows: object[], pagination: { hasMore: boolean, next: { beforeAudit: number|null, beforeComment: number|null } } }}
   */
  async fetchFeed(documentName, {
    audit = true, comments = true, onlyApproved = false, includeEvents = true,
    cursor = {}, limit,
  } = {}) {
    const target = this.commentTarget();
    const size = Math.min(Math.max(parseInt(limit) || FEED_PAGE, 1), FEED_PAGE_MAX);
    const beforeAudit = parseInt(cursor.beforeAudit) || null;
    const beforeComment = parseInt(cursor.beforeComment) || null;

    const db = (table) => loopar.db.qx()(table);
    const older = (qb, id) => (id ? qb.where('id', '<', id) : qb);
    const visible = (qb) => (onlyApproved ? qb.where('status', DOC_STATUS.APPROVED) : qb);
    const ofRecord = { document: target, document_name: documentName };

    // One more than the page from each table tells whether anything is left.
    const events = audit
      ? await older(db(HISTORY_TABLE).select(['id', ...AUDIT_FIELDS]).where(ofRecord), beforeAudit)
        .orderBy('id', 'desc').limit(size + 1)
      : [];
    const roots = comments
      ? await visible(older(
        db(COMMENT_TABLE).select(['id', ...COMMENT_FIELDS]).where(ofRecord)
          .where((b) => b.whereNull('parent').orWhere('parent', '')),
        beforeComment,
      )).orderBy('id', 'desc').limit(size + 1)
      : [];

    const commentRow = (r) => ({
      name: r.name,
      document: r.document,
      document_name: r.document_name,
      parent: r.parent || null,
      user: commenterName(r),
      comment: r.comment,
      status: r.status,
      event_at: r.created_at,
      action: 'Commented',
    });
    const auditRow = ({ id, ...r }) => r;

    // Merge the two newest-first lists until the page is full.
    const time = (v) => new Date(v || 0).getTime();
    const feed = [];
    let e = 0, c = 0;
    while (feed.length < size && (e < events.length || c < roots.length)) {
      const takeEvent = c >= roots.length
        || (e < events.length && time(events[e].event_at) >= time(roots[c].created_at));
      feed.push(takeEvent ? auditRow(events[e++]) : commentRow(roots[c++]));
    }
    const pageEvents = events.slice(0, e);
    const pageRoots = roots.slice(0, c);

    const thread = [];
    if (comments) {
      // Comments on the page's events; their replies carry the same target.
      if (includeEvents && pageEvents.length) {
        thread.push(...await visible(
          db(COMMENT_TABLE).select(COMMENT_FIELDS)
            .where('document', HISTORY_TABLE)
            .whereIn('document_name', pageEvents.map(r => r.name)),
        ));
      }

      // Replies under the page's root comments, level by level.
      let parents = pageRoots.map(r => r.name);
      for (let depth = 0; parents.length && depth < THREAD_DEPTH_MAX; depth++) {
        const replies = await visible(
          db(COMMENT_TABLE).select(COMMENT_FIELDS).where(ofRecord).whereIn('parent', parents),
        );
        thread.push(...replies);
        parents = replies.map(r => r.name);
      }
    }

    return {
      rows: [...feed, ...thread.map(commentRow)],
      pagination: {
        hasMore: e < events.length || c < roots.length,
        next: {
          beforeAudit: e ? pageEvents[e - 1].id : beforeAudit,
          beforeComment: c ? pageRoots[c - 1].id : beforeComment,
        },
      },
    };
  }

  /**
   * Unified desk feed: audit events + comments interleaved (newest first).
   * Sensitive (permission-gated, NOT public) so diffs only reach authorized
   * users.
   * Query: { documentName, limit?, beforeAudit?, beforeComment? }   (documentHistory: optional owner override)
   */
  async actionHistory(q, documentHistory) {
    q ??= this.query || {};
    this.documentHistory = documentHistory || this.document;

    const documentName = q.documentName ? String(q.documentName).trim() : null;
    if (!documentName) return { rows: [], pagination: {} };

    const ref = loopar.getRef?.(this.document) || {};
    return await this.fetchFeed(documentName, {
      audit: !!ref.enable_history,
      comments: !!ref.enable_comments,
      cursor: q,
      limit: q.limit,
    });
  }

  /**
   * Public comment tree for a document — APPROVED only, no audit/diffs, no
   * event-comments (the public web shows the record's discussion, not the log).
   * Query: { documentName, limit?, beforeComment? }
   */
  async publicActionComments() {
    const q = this.query || {};
    const documentName = q.documentName ? String(q.documentName).trim() : null;
    if (!documentName) return { rows: [], pagination: {} };

    const ref = loopar.getRef?.(this.document) || {};
    if (!ref.enable_comments) return { rows: [], pagination: {} };

    return await this.fetchFeed(documentName, {
      audit: false, onlyApproved: true, includeEvents: false, cursor: q, limit: q.limit,
    });
  }

  /**
   * Write a comment (threaded via `parent`). Authenticated → auto-APPROVED;
   * guest → PENDING with name/email; login can be required per entity. When
   * `body.document === "Document History"` the comment targets a specific
   * audit event (comment-on-an-event) instead of the record.
   * Body: { documentName, comment, parent?, document?, guest_name?, guest_email? }
   */
  async actionAddComment() {
    const d = this.data || {};
    const target = this.commentTarget();
    const ref = loopar.getRef?.(target) || {};
    if (!ref.enable_comments) loopar.throw({ status: 403, title: 'Forbidden', message: 'Comments are not enabled for this document' });

    const documentName = d.documentName ? String(d.documentName).trim() : null;
    const comment = String(d.comment || '').trim();
    if (!documentName) loopar.throw('documentName is required');
    if (!comment) loopar.throw('Comment is required');
    if (comment.length > MAX_COMMENT_LEN) {
      loopar.throw(`Comment is too long (max ${MAX_COMMENT_LEN} characters)`);
    }

    const authedName = loopar.currentUser?.name;
    const isGuest = !authedName || authedName === 'Guest';
    if (ref.require_login_to_comment && isGuest) loopar.throw({ status: 401, title: 'Sign in required', message: 'Sign in to comment' });

    const status = isGuest ? DOC_STATUS.PENDING : DOC_STATUS.APPROVED;
    const commentDocument = d.document === HISTORY_TABLE ? HISTORY_TABLE : target;

    const name = await loopar.comments.add({
      document: commentDocument,
      documentName,
      comment,
      parent: d.parent ? String(d.parent).trim() : null,
      status,
      guest_name: isGuest ? (String(d.guest_name || '').trim() || 'Anonymous') : null,
      guest_email: isGuest ? (String(d.guest_email || '').trim() || null) : null,
    });

    return { ok: true, name, pending: isGuest };
  }

  /**
   * Approve / change a comment's status. Desk-only (permission-gated, rejected
   * on the public web). Body: { name, status }
   */
  async actionModerate() {
    if (workspaceServesWebPages(this.req?.__WORKSPACE_NAME__)) loopar.throw({ status: 403, title: 'Forbidden', message: 'Not allowed' });

    const d = this.data || {};
    if (!d.name) loopar.throw('name is required');

    const doc = await loopar.getDocument(COMMENT_TABLE, d.name);
    if (!doc) loopar.throw({ status: 404, title: 'Not found', message: `Comment "${d.name}" not found` });

    doc.status = coerceDocStatus(d.status);
    await doc.save({ validate: false });
    // `status` is reserved in action responses (router reads it as the HTTP
    // code). Return the new moderation state under a non-reserved key.
    return { ok: true, name: d.name, newStatus: doc.status };
  }
}