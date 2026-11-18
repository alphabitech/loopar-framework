'use strict';

import crypto from 'crypto';
import { BaseDocument, loopar, getRequest, snapshotHTML } from 'loopar';

/** Page that renders the signing screen; a website menu row (router only) points at it. */
export const SIGNING_PAGE = 'Document Signing';
const DEFAULT_DAYS = 30;

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const nowISO = () => new Date().toISOString();
/** DB date_time ('YYYY-MM-DD HH:mm:ss', server time) or ISO → ISO (UTC), for the browser to localize. */
const toISO = (v) => {
  if (!v) return null;
  const d = new Date(String(v).includes('T') ? v : String(v).replace(' ', 'T'));
  return isNaN(d.getTime()) ? null : d.toISOString();
};
/**
 * What the signer is asked for. Both keep the same evidence; the wording is
 * what changes, so nobody "signs" a document that is only being approved:
 *   Signature — a contract or agreement the signer commits to.
 *   Approval  — a go-ahead on a document (a quote, a proposal) whose own
 *               terms say what the approval means.
 * `consent` is the statement the signer accepts; it is stored with the signature.
 */
export const PURPOSES = {
  Signature: {
    verb: 'sign', done: 'signed', doneTitle: 'Signed',
    invite: 'to review and sign electronically',
    consent: 'I agree to sign this document electronically. My typed name is my signature and has the same effect as a handwritten one, and I agree to receive this document and related records electronically.',
  },
  Approval: {
    verb: 'approve', done: 'approved', doneTitle: 'Approved',
    invite: 'to review and approve online',
    consent: 'I have reviewed this document and I approve it. My approval is subject to the terms stated in the document, and I agree to receive this document and related records electronically.',
  },
};

const escapeHTML = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Electronic signature of a document by someone outside the system, through
 * a link (no account). Any model can ask for one:
 *
 *   const { request, url } = await SignatureRequest.issue({
 *     document: 'Staffing Rate Agreement', documentName: 'SRA-0001',
 *     title: 'Service Agreement', html, signerName, signerEmail,
 *   });
 *
 * Instead of `html`, pass `snapshot` (loopar's printSnapshot of a record):
 * the signer sees the record on its Print Format, the same sheet the desk
 * prints. The snapshot is stored as it was (format, values, labels,
 * letterhead) together with its content as plain HTML, so the copy that was
 * signed can always be read, however the print components look later.
 *
 * The exact content shown to the signer is stored with its SHA-256, and the
 * signature keeps the evidence (typed name and title, consent, time, IP,
 * browser). When the signer signs or declines, the source record's
 * `onSignatureSigned(request)` / `onSignatureDeclined(request)` run.
 *
 * Only a hash of the link token is stored: a lost link is replaced with
 * `rotate()` (resend), which invalidates the previous one.
 */
export default class SignatureRequest extends BaseDocument {
  constructor(props) {
    super(props);
  }

  /** Website path of the signing page (`/sign`), from the menu of the active website. */
  static signingPath() {
    const item = (loopar.webApp?.menu_items || []).find((m) => m.page === SIGNING_PAGE);
    if (!item?.link) {
      loopar.throw(`The website has no page for e-signatures. Add a menu row (router only) with page "${SIGNING_PAGE}", e.g. link "sign".`);
    }
    return `/${item.link}`;
  }

  /** Origin of the current request (proxy headers first), e.g. https://example.com. */
  static origin() {
    const req = getRequest();
    const proto = String(req?.headers?.['x-forwarded-proto'] || req?.protocol || 'http').split(',')[0].trim();
    const host = String(req?.headers?.['x-forwarded-host'] || req?.headers?.host || process.env.DOMAIN || 'localhost').split(',')[0].trim();
    return `${proto}://${host}`;
  }

  static async issue({ document, documentName, title, html, snapshot = null, purpose = 'Signature', signerName, signerEmail, sender = null, days = DEFAULT_DAYS, message = '' }) {
    if (!PURPOSES[purpose]) loopar.throw(`Unknown purpose "${purpose}": use Signature or Approval.`);
    if (snapshot) html = snapshotHTML(snapshot);
    if (!html) loopar.throw('Nothing to sign: the document is empty.');
    const data = snapshot ? JSON.stringify(snapshot) : '';
    if (!signerName || !signerEmail) loopar.throw('The signer name and email are required.');
    const path = SignatureRequest.signingPath();

    // A new request replaces the pending ones of the same record.
    const pending = await loopar.db.getAll('Signature Request', ['name'], { document, document_name: documentName, status: 'Pending' });
    for (const { name } of pending) {
      const old = await loopar.getDocument('Signature Request', name);
      old.status = 'Revoked';
      await old.save({ validate: false });
    }

    const request = await loopar.newDocument('Signature Request', {
      title, purpose, document, document_name: documentName,
      sender: sender || await SignatureRequest.siteName(),
      signer_name: signerName, signer_email: signerEmail,
      content_html: html, content_data: data, content_hash: SignatureRequest.digest(html, data),
      status: 'Pending',
    });
    const url = await request.newLink(path, days);
    await request.save({ validate: false });
    const emailed = await request.sendLink(url, message);
    return { request, url, emailed };
  }

  /** SHA-256 of what the signer is shown: the HTML and, when there is one, the print snapshot. */
  static digest(html, data = '') {
    return sha256(data ? `${html}\n${data}` : html);
  }

  /** The stored content is the one that was hashed when the request was issued. */
  intact() {
    return SignatureRequest.digest(this.content_html, this.content_data || '') === this.content_hash;
  }

  /** Wording of this request (see PURPOSES). */
  wording() {
    return PURPOSES[this.purpose] || PURPOSES.Signature;
  }

  async newLink(path, days) {
    const token = crypto.randomBytes(32).toString('base64url');
    this.token_hash = sha256(token);
    this.sent_at = nowISO();
    this.expires_at = new Date(Date.now() + days * 86400000).toISOString();
    return `${SignatureRequest.origin()}${path}?token=${token}`;
  }

  /** New link (the previous one stops working) and email it again. */
  async rotate({ email = true, days = DEFAULT_DAYS } = {}) {
    if (this.status !== 'Pending' && this.status !== 'Expired') {
      loopar.throw(`This request is ${this.status}: a new link can only be sent while it is pending.`);
    }
    const url = await this.newLink(SignatureRequest.signingPath(), days);
    this.status = 'Pending';
    await this.save({ validate: false });
    const emailed = email ? await this.sendLink(url) : null;
    return { url, emailed };
  }

  async revoke() {
    if (this.status !== 'Pending') loopar.throw(`This request is ${this.status}.`);
    this.status = 'Revoked';
    await this.save({ validate: false });
  }

  /**
   * Emails the link in the background: the caller doesn't wait for the mail
   * server. True = queued; a delivery that fails is noted on the source
   * record's history (one attempt: a retry could carry a link that a resend
   * already replaced).
   */
  async sendLink(url, message = '') {
    const company = this.sender || await SignatureRequest.siteName();
    try {
      await loopar.mail.sendLater({
        maxAttempts: 1,
        onFailed: (error) => this.#emailFailed(error),
        to: this.signer_email,
        subject: `${this.title} — please review and ${this.wording().verb}`,
        html: `<p>Hello ${escapeHTML(this.signer_name)},</p>
<p>${escapeHTML(company)} sent you <strong>${escapeHTML(this.title)}</strong> ${this.wording().invite}.</p>
${message ? `<p>${escapeHTML(message)}</p>` : ''}
<p><a href="${url}" style="background:#15803d;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Review and ${this.wording().verb}</a></p>
<p style="color:#666;font-size:12px">This link is personal and expires on ${escapeHTML(String(toISO(this.expires_at)).slice(0, 10))}. If the button doesn't work, copy this address:<br>${url}</p>`,
      });
      return true;
    } catch (e) {
      console.warn(`[signature] email to ${this.signer_email} failed:`, e.message);
      return false;
    }
  }

  async #emailFailed(error) {
    await loopar.comments.add({
      document: this.document, documentName: this.document_name,
      status: loopar.comments.STATUS.APPROVED,
      comment: `The signature email to ${this.signer_email} could not be sent (${error}). Open signature request ${this.name} to send a new link or share it.`,
    });
  }

  /** Fallback sender: the website's description or name. */
  static async siteName() {
    return loopar.webApp?.description || loopar.webApp?.name || 'We';
  }

  /** The request a public link points to (null when the token is unknown). */
  static async byToken(token) {
    if (!token || String(token).length < 20) return null;
    const [row] = await loopar.db.getAll('Signature Request', ['name'], { token_hash: sha256(token) });
    if (!row) return null;
    const request = await loopar.getDocument('Signature Request', row.name);
    if (request.status === 'Pending' && request.expires_at && new Date(toISO(request.expires_at)) < new Date()) {
      request.status = 'Expired';
      await request.save({ validate: false });
    }
    return request;
  }

  /** What the signing page shows. Signed copies stay viewable through the same link. */
  async publicView() {
    if (this.status === 'Pending' && !this.viewed_at) {
      this.viewed_at = nowISO();
      await this.save({ validate: false });
    }
    return {
      name: this.name,
      title: this.title,
      purpose: PURPOSES[this.purpose] ? this.purpose : 'Signature',
      // The statement to accept: the one already accepted, once there is one.
      consent: this.consent_text || this.wording().consent,
      status: this.status,
      company: this.sender || await SignatureRequest.siteName(),
      signer_name: this.signer_name,
      signer_email: this.signer_email,
      expires_at: toISO(this.expires_at),
      signed_at: toISO(this.signed_at),
      signed_name: this.signed_name,
      signed_title: this.signed_title,
      content_hash: this.content_hash,
      intact: this.intact(),
      html: this.content_html,
      // A record on its Print Format: the page draws the sheet; `html` is its plain copy.
      snapshot: this.content_data ? loopar.utils.JSONparse(this.content_data, null) : null,
    };
  }

  #evidence() {
    const req = getRequest();
    const forwarded = String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
    this.ip_address = forwarded || req?.ip || req?.socket?.remoteAddress || '';
    this.user_agent = String(req?.headers?.['user-agent'] || '').slice(0, 255);
    this.signed_at = nowISO();
  }

  #assertPending() {
    if (this.status !== 'Pending') loopar.throw(`This document is ${this.status.toLowerCase()} and can no longer be ${this.wording().done}.`);
    if (!this.intact()) loopar.throw('The document changed after it was sent. Ask for a new link.');
  }

  async sign({ signed_name, signed_title, agree }) {
    this.#assertPending();
    const name = String(signed_name || '').trim();
    if (!name) loopar.throw(`Type your full name to ${this.wording().verb}.`);
    if (![true, 1, '1', 'true', 'on'].includes(agree)) loopar.throw('You must accept the statement to continue.');

    this.#evidence();
    this.signed_name = name.slice(0, 140);
    this.signed_title = String(signed_title || '').trim().slice(0, 140);
    // The exact statement the signer accepted.
    this.consent_text = this.wording().consent;
    this.status = 'Signed';
    await this.save({ validate: false });

    await this.#notifySource('onSignatureSigned');
    await this.#confirmation();
  }

  async decline({ reason }) {
    this.#assertPending();
    this.#evidence();
    this.decline_reason = String(reason || '').trim().slice(0, 2000) || 'No reason given.';
    this.status = 'Declined';
    await this.save({ validate: false });
    await this.#notifySource('onSignatureDeclined');
  }

  /** The signature stands even if the source record's follow-up fails; the error is logged. */
  async #notifySource(hook) {
    try {
      const source = await loopar.getDocument(this.document, this.document_name);
      if (typeof source[hook] === 'function') await source[hook](this);
    } catch (e) {
      console.error(`[signature] ${hook} of ${this.document} ${this.document_name} failed:`, e);
    }
  }

  async #confirmation() {
    try {
      await loopar.mail.send({
        to: this.signer_email,
        subject: `${this.wording().doneTitle}: ${this.title}`,
        html: `<p>Hello ${escapeHTML(this.signer_name)},</p>
<p>Thank you. You ${this.wording().done} <strong>${escapeHTML(this.title)}</strong> on ${escapeHTML(String(toISO(this.signed_at)).slice(0, 16).replace('T', ' '))} UTC.</p>
<p>You can open, print or save your copy with the same link you received.</p>`,
      });
    } catch (e) {
      console.warn('[signature] confirmation email failed:', e.message);
    }
  }
}
