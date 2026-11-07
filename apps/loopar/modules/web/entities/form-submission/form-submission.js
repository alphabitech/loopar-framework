
'use strict';

import { BaseDocument, loopar } from 'loopar';

const SPAM_THRESHOLD = 2;

/**
 * Storage for the generic web-form pipeline.
 *
 * Validation happens upstream (PageController.publicActionSubmitForm): the
 * page acts as its own data model and the scoping helpers in
 * core/document/web-form.js restrict it to the submitted form. This entity
 * only persists the result — payload as JSON, silent-Spam workflow — and
 * sends the optional notification the form's metadata asks for.
 */
export default class FormSubmission extends BaseDocument {
  async beforeSave() {
    if (this.__IS_NEW__) {
      this.name = this.generateId();
      this.status = this.status || 'New';
      this.submitted_at = new Date().toISOString();
    }
  }

  generateId() {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 6);
    return `FS-${timestamp}-${random}`.toUpperCase();
  }

  /**
   * Persist a validated submission. Soft bot signals (fast fill, missing
   * timing) mark it as Spam silently instead of rejecting — reviewable in
   * the desk, no notification, sender sees a normal success.
   */
  async register({ formNode, payload, context = {} }) {
    const reasons = [];
    let score = 0;

    if (context.fastFill) {
      score += context.humanVerified ? 1 : 2;
      reasons.push('fast-fill');
    }

    this.spam_score = score;
    this.spam_reasons = reasons.join(', ');

    const isSpam = score >= SPAM_THRESHOLD;
    if (isSpam) this.status = 'Spam';

    this.form_label = formNode?.data?.title || formNode?.data?.label || formNode?.data?.name || 'Form';
    this.payload = JSON.stringify(payload);

    await this.save();

    if (!isSpam) {
      await this.notify(formNode, payload);
    }

    return isSpam ? 'spam' : 'ok';
  }

  /**
   * Optional email notification, driven by the form's own metadata:
   * `notify` switch turns it on, `notify_email` overrides the recipient
   * (falls back to Email Settings notification/from email).
   */
  async notify(formNode, payload) {
    const meta = formNode?.data || {};
    if (![1, '1', true, 'true'].includes(meta.notify)) return;

    try {
      const to = meta.notify_email || await loopar.mail.notificationEmail();
      if (!to) return;

      const escapeHTML = (v) => String(v ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

      const rows = Object.entries(payload).map(([k, v]) =>
        `<tr><td style="padding:4px 8px"><strong>${escapeHTML(k)}</strong></td><td style="padding:4px 8px">${escapeHTML(v)}</td></tr>`
      ).join('');

      await loopar.mail.send({
        to,
        subject: `New submission: ${this.form_label} (${this.form_page})`,
        html: `
          <h2>${escapeHTML(this.form_label)}</h2>
          <p>From page: ${escapeHTML(this.form_page)}</p>
          <table border="0" cellspacing="0">${rows}</table>
        `
      });
    } catch (error) {
      console.error('[form-submission] notify failed:', error.message);
    }
  }
}
