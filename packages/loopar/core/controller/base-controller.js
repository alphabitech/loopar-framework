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
import { titleize } from "inflection";

const HISTORY_TABLE = 'Document History';
const COMMENT_TABLE = 'Comment';

const AUDIT_FIELDS = ['name', 'user', 'action', 'event_at', 'diff', 'metadata'];
const COMMENT_FIELDS = ['name', 'document', 'document_name', 'parent', 'user', 'guest_name', 'guest_email', 'comment', 'status', 'created_at'];

const MAX_COMMENT_LEN = 2000;

function commenterName(row) {
  return row.user || row.guest_name || 'Guest';
}

export default class BaseController extends CoreController {
  defaultAction = 'list';
  hasSidebar = true;
  static enabledActions = []

  async actionList() {
    if (this.query?.board !== undefined) return await this.#boardColumn();

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

  /**
   * Kanban column (data endpoint): `{Entity}/list?board=<state>&page=N`.
   * Same permission, search and owner scope as the list.
   */
  async #boardColumn() {
    const workflow = await workflowFor(this.document);
    if (!workflow) loopar.throw(`${this.document} has no active workflow.`);
    const q = { ...loopar.getQ(this.document) };
    const document = await loopar.newDocument(this.document);
    return await document.getBoardColumn({
      field: workflow.field,
      state: String(this.query.board),
      q: Object.keys(q).length ? q : null,
      page: parseInt(this.query.page, 10) || 1,
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
        `${(Entity.name === "Entity") ? document.type || "Entity" : (isSingle ? "" : Entity.name)} ${isSingle ? Entity.name : document.name} saved successfully`, { name: document.name }
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
          data: await document.values(),
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

  async fetchAudit(documentName) {
    const filters = { document: this.commentTarget(), document_name: documentName };
    const list = await loopar.getList(HISTORY_TABLE, { fields: AUDIT_FIELDS, filters, page: parseInt(this.query?.page) || 1 });
    return list.rows || [];
  }

  /**
   * Comments in scope for a record: comments ON the record itself, plus
   * (when includeEvents) comments ON any of its audit events — i.e. a Comment
   * whose target is a "Document History" row. Normalized to a common shape
   * (event_at, action, display user); `parent` lets the client build the tree.
   */
  async fetchComments(documentName, { onlyApproved = false, includeEvents = true } = {}) {
    const target = this.commentTarget();

    let eventIds = [];
    if (includeEvents) {
      const events = await loopar.db.qx()(HISTORY_TABLE)
        .select('name')
        .where({ document: target, document_name: documentName });
      eventIds = events.map(e => e.name);
    }

    let qb = loopar.db.qx()(COMMENT_TABLE)
      .select(COMMENT_FIELDS)
      .where((b) => {
        b.where((g) => g.where('document', target).andWhere('document_name', documentName));
        if (eventIds.length) {
          b.orWhere((g) => g.where('document', HISTORY_TABLE).whereIn('document_name', eventIds));
        }
      });

    if (onlyApproved) qb = qb.where('status', DOC_STATUS.APPROVED);
    qb = qb.orderBy('created_at', 'asc');

    const rows = await qb;
    return rows.map(r => ({
      name: r.name,
      document: r.document,
      document_name: r.document_name,
      parent: r.parent || null,
      user: commenterName(r),
      comment: r.comment,
      status: r.status,
      event_at: r.created_at,
      action: 'Commented',
    }));
  }

  /**
   * Unified desk feed: audit events + comments interleaved (newest first).
   * Sensitive (permission-gated, NOT public) so diffs only reach authorized
   * users. Comment rows carry `parent` so the client builds the tree.
   * Query: { documentName }   (documentHistory: optional owner override)
   */
  async actionHistory(q, documentHistory) {
    q ??= this.query || {};
    this.documentHistory = documentHistory || this.document;

    const documentName = q.documentName ? String(q.documentName).trim() : null;
    if (!documentName) return { rows: [], pagination: {} };

    const ref = loopar.getRef?.(this.document) || {};
    const audit = ref.enable_history ? await this.fetchAudit(documentName) : [];
    const comments = ref.enable_comments ? await this.fetchComments(documentName) : [];

    const rows = [...audit, ...comments].sort(
      (a, b) => new Date(b.event_at || 0) - new Date(a.event_at || 0)
    );

    return { rows, pagination: {} };
  }

  /**
   * Public comment tree for a document — APPROVED only, no audit/diffs, no
   * event-comments (the public web shows the record's discussion, not the log).
   * Query: { documentName }
   */
  async publicActionComments() {
    const q = this.query || {};
    const documentName = q.documentName ? String(q.documentName).trim() : null;
    if (!documentName) return { rows: [], pagination: {} };

    const ref = loopar.getRef?.(this.document) || {};
    if (!ref.enable_comments) return { rows: [], pagination: {} };

    const rows = await this.fetchComments(documentName, { onlyApproved: true, includeEvents: false });
    return { rows, pagination: {} };
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