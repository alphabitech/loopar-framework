'use strict'

import SingleConrtroller from './single-controller.js';
import { loopar } from "loopar";
import { findFormNode, formFields, scopedErrors, pickPayload, botContext, verifyCaptcha } from '../document/web-form.js';

/**
 * Best-effort geo lookup. Hardened on purpose:
 * - `request.ip` can be attacker-influenced (X-Forwarded-For behind a proxy),
 *   so it's validated as a plain IPv4/IPv6 literal before being interpolated
 *   into the URL (no path/query smuggling into the fetch).
 * - try/catch + timeout: ip-api.com being down, slow, or rate-limited
 *   (45 req/min free tier) must NEVER fail or hang the review submission.
 */
const detectCity = async (request) => {
  const ip = request.ip;

  if (
    !ip || ip === "::1" || ip === "127.0.0.1" ||
    !/^[0-9a-fA-F:.]{3,45}$/.test(ip)
  ) {
    return { city: "", region: "" };
  }

  try {
    const res = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}`, {
      signal: AbortSignal.timeout(1500),
    });
    const data = await res.json();

    return {
      city: data.city   || "",
      region: data.region || "",
    };
  } catch (e) {
    return { city: "", region: "" };
  }
}

/** Clamp a client-provided pagination number: NaN-safe, bounded. */
const clampInt = (value, def, min, max) => {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(n, min), max);
}

export default class PageController extends SingleConrtroller {
  client = 'page';
  static inheritedActions = ['view'];

  constructor(props) {
    super(props);
  }

  #getApp() {
    return loopar.webApp;
  }

  /**
   * Anti-bot gate for public write actions (reviews, guest comments).
   * Tries the captcha providers in order — ALTCHA (self-hosted PoW) first,
   * Turnstile second — and enforces the first one that is active. Missing/
   * unmigrated entities mean the integration is off and the gate is a no-op.
   */
  async #assertHuman() {
    const token = this.data?.captcha_token ?? this.body?.captcha_token;
    // true → sender positively verified as human (softens fast-fill)
    return await verifyCaptcha(loopar, token, this.req?.ip);
  }

  async publicActionGetReviews() {
    const { limit = 6, offset = 0 } = this.query;
 
    const filter = {parent_id: this.document, approved: 1 };
 
    const reviews = await loopar.db.getList("Review", {
      filter,
      fields: ["name", "author_name", "city", "rating", "comment", "creation", "helpful", "not_helpful"],
      orderBy: "creation desc",
      // Clamped: `?limit=abc` produced NaN in the SQL and `?limit=999999`
      // allowed dumping the table from an unauthenticated endpoint.
      limit: clampInt(limit, 6, 1, 50),
      offset: clampInt(offset, 0, 0, 100000),
    });
 
    return reviews
  }


  async actionView(...args) {
    return await this.sendDocument(...args);
  }

  async publicActionAddReview() {
    await this.#assertHuman();

    const { author_name, city, rating, comment, app } = this.body;
    const _app = this.#getApp();

    if (!author_name?.trim()) return this.error("Author name is required.");
    if (!comment?.trim()) return this.error("Comment is required.");
    if (rating < 1 || rating > 5) return this.error("Rating must be between 1 and 5.");
 
    const doc = await loopar.newDocument("Review", {
      name: loopar.utils.randomString(15),
      author_name: author_name.trim(),
      city: (await detectCity(this.req)).city,
      rating: parseInt(rating),
      comment: comment.trim(),
      app: _app.name || "",
      parent_id: this.document,
      approved: 0,
      helpful: 0,
      not_helpful: 0,
    });
 
    await doc.save();
 
    return this.success("Review submitted. It will appear once approved.");
  }
 
  async publicActionVoteReview() {
    const { review_id, vote } = this.body;
 
    if (!review_id) return this.error("review_id is required.");
    if (!["helpful", "not_helpful"].includes(vote)) return this.error("Invalid vote type.");
 
    const review = await loopar.db.getDoc("Review", { name: review_id, approved: 1 }, 
      ["name", vote, "not_helpful"]);
 
    if (!review) return this.error("Review not found.");
    await loopar.db.setValue("Review", vote, review[vote] + 1, review_id);
 
    return this.success("Vote registered.");
  }

  async publicActionLoadGalery(){
    const ref = loopar.getRef(this.document);

    const m = await loopar.newDocument("File Manager", {app: ref.__APP__});
    m.pageSize = clampInt(this.data.pageSize, 10, 1, 50);
    m.page = clampInt(this.data.page, 1, 1, 100000);
    const files = await m.getList();

    return { rows: files.rows, pagination: files.pagination };
  }

  async publicActionAddComment() {
    // Only guests face the anti-bot check; authenticated users already
    // proved themselves at login and their comments are auto-approved.
    const authedName = loopar.currentUser?.name;
    const isGuest = !authedName || authedName === 'Guest';
    if (isGuest) await this.#assertHuman();

    this.documentHistory = "Page Builder"
    return await super.actionAddComment();
  }

  async publicActionHistory() {
    this.documentHistory = "Page Builder"
    if(this.req.__WORKSPACE_NAME__ == "desk"){
      return await this.actionHistory({
        ...this.query,
        documentType: "Page Builder",
        documentName: this.document
      }, "Page Builder")
    }

    const documentName = this.document;
    if (!documentName) return { rows: [], pagination: {} };

    const ref = loopar.getRef?.("Page Builder") || {};
    if (!ref.enable_comments) return { rows: [], pagination: {} };

    const rows = await this.fetchComments(documentName, { onlyApproved: true, includeEvents: false });
    return { rows, pagination: {} };
  }

  // Kept for compatibility while the client migrates to `submitForm`.
  async publicActionSubmitContactForm() {
    return await this.publicActionSubmitForm();
  }

  async publicActionSubmitForm() {
    const body = this.data || {};
    const bot = botContext(body);

    if (bot.honeypot) return this.success('Submitted successfully');

    const humanVerified = await this.#assertHuman();

    const selfDoc = await loopar.newDocument(this.document, body);

    const formNode = findFormNode(selfDoc.__ENTITY__?.doc_structure, {
      node: body.node ? String(body.node) : null,
      formName: body.form_name ? String(body.form_name) : null
    });
    if (!formNode) return this.error('Form not found');

    const scope = new Set(formFields(formNode).map(f => f.data.name));
    if (!scope.size) return this.error('Form has no fields');

    const errors = scopedErrors(selfDoc, scope);
    if (errors.length) loopar.throw(errors.join('<br/>'));

    const payload = pickPayload(scope, body);

    // Storage: auditable record with silent-Spam workflow. If the entity's
    // schema isn't migrated yet, log and continue — validation already ran.
    try {
      const submission = await loopar.newDocument('Form Submission');
      submission.form_page = this.document;
      submission.form_node = String(body.node || formNode.node || '');
      submission.ip_address = this.req?.ip || '';
      await submission.register({
        formNode,
        payload,
        context: { fastFill: bot.fastFill, humanVerified }
      });
    } catch (error) {
      console.warn('[page-controller] Form Submission storage unavailable:', error.message);
    }

    return this.success(formNode.data?.success_message || 'Submitted successfully');
  }
}