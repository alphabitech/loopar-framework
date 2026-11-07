
'use strict';

import {BaseDocument, loopar} from 'loopar';
import mailchecker from 'mailchecker';

// score >= SPAM_THRESHOLD  → saved with status "Spam", admin not notified
// score >= REJECT_THRESHOLD → not even saved (obvious junk)
const SPAM_THRESHOLD = 2;
const REJECT_THRESHOLD = 6;

// Google ignores dots in the local part; "+suffix" is an alias everywhere.
// Normalizing lets us dedupe/flag senders that rotate infinite variants
// like pr.an.ab.h.uec.o.d.e.1@gmail.com.
function normalizeEmail(email) {
  const [rawLocal = '', rawDomain = ''] = String(email || '').trim().toLowerCase().split('@');
  const domain = rawDomain === 'googlemail.com' ? 'gmail.com' : rawDomain;

  let local = rawLocal.split('+')[0];
  if (domain === 'gmail.com') local = local.replace(/\./g, '');

  return domain ? `${local}@${domain}` : '';
}

function detectSpamHeuristics(text) {
  const hits = [];
  if (!text) return { score: 0, hits };

  // Extra points beyond one-per-hit (stacked keywords, see below).
  let extra = 0;

  const urls = text.match(/https?:\/\/|www\./gi) || [];
  if (urls.length >= 3) hits.push('too-many-urls');

  // Caps ratio over the text WITHOUT URLs: link paths/domains are lowercase
  // and dilute the ratio, letting an ALL-CAPS pitch stuffed with links slip
  // under the 0.6 threshold.
  const textSansUrls = text.replace(/(?:https?:\/\/|www\.)\S+/gi, ' ');
  const letters = textSansUrls.match(/[A-Za-z]/g) || [];
  const upper = textSansUrls.match(/[A-Z]/g) || [];
  if (letters.length >= 50 && upper.length / letters.length > 0.6) hits.push('too-much-caps');

  if (/(.)\1{6,}/.test(text)) hits.push('char-repeat');

  // Universal spam tokens ONLY — brand names / internationalisms that bots
  // write identically in every language (a Russian or Vietnamese bot still
  // types "viagra" and "crypto"). Deliberately NO language-bound phrases:
  // phrasing is unbounded across locales, structure isn't — anything
  // language-specific belongs in per-tenant config, not in core.
  const SPAM_RE = new RegExp(
    String.raw`\b(viagra|cialis|casino|porn|crypto|bitcoin|nft|airdrop|forex|seo backlinks)\b`,
    'gi'
  );
  // Count UNIQUE tokens (capped at +3), not a flat +1: with a single
  // .test() a message stacking several tokens still scored 1 point here,
  // making REJECT_THRESHOLD (6) unreachable for text-only signals.
  const uniqueKeywords = new Set(
    (text.match(SPAM_RE) || []).map((m) => m.toLowerCase().replace(/\s+/g, ' '))
  );
  if (uniqueKeywords.size > 0) {
    const points = Math.min(3, uniqueKeywords.size);
    hits.push(points > 1 ? `spam-keywords(+${points})` : 'spam-keyword');
    extra += points - 1;
  }

  const exclamations = (text.match(/!/g) || []).length;
  if (exclamations >= 6) hits.push('too-many-exclamations');

  // Money bait: a currency amount plus shouted urgency ("$500!!!") reads
  // the same in every language. Amount alone never scores — legit messages
  // quote budgets ("presupuesto de $500 para el evento").
  const hasMoney = /[$€£¥₹]\s?\d{2,}|\b\d{2,}\s?(usd|eur|gbp)\b/i.test(text);
  if (hasMoney && exclamations >= 3) hits.push('money-bait');

  // Messenger funnels: wa.me / t.me links are how spam moves the target
  // off-site; a legit sender uses the form's own reply channel.
  if (/\b(wa\.me|t\.me|telegram\.(me|org)|chat\.whatsapp\.com)\//i.test(text)) hits.push('messenger-link');

  // Mostly links: URLs make up over a third of the message body.
  const urlChars = (text.match(/(?:https?:\/\/|www\.)\S+/gi) || []).join('').length;
  if (urlChars > 0 && urlChars / text.length > 0.35) hits.push('mostly-links');

  if (/\[\s*(at|dot)\s*\]/i.test(text)) hits.push('obfuscated-contact');

  return { score: hits.length + extra, hits };
}

export default class ContactMessage extends BaseDocument {
  async beforeSave() {
    if (this.__IS_NEW__) {
      this.name = this.generateId();
      this.status = this.status || 'New';
      this.submitted_at = new Date().toISOString();
    }
  }

  /**
   * @param {Object} [context]
   * @param {boolean} [context.fastFill] - form submitted faster than a human
   *   could type it (or without the timing field at all) — set by the controller.
   * @param {boolean} [context.humanVerified] - Turnstile positively verified
   *   the sender; softens the fast-fill penalty.
   */
  async send(context = {}) {
    this.validateFields();

    const { score, hits } = await this.computeSpamScore(context);

    this.normalized_email = normalizeEmail(this.email);
    this.spam_score = score;
    this.spam_reasons = hits.join(', ');

    if (score >= REJECT_THRESHOLD) {
      console.warn(`[contact-message] rejected as spam (score=${score}):`, hits);
      loopar.throw('Message rejected');
    }

    await this.checkRateLimit();
    this.sanitizeFields();

    const isSpam = score >= SPAM_THRESHOLD;
    if (isSpam) {
      this.status = 'Spam';
      console.warn(`[contact-message] stored as Spam (score=${score}):`, hits);
    }

    await this.save();

    if (!isSpam) {
      await this.notifyAdmin();
    }

    return isSpam ? 'spam' : 'ok';
  }

  validateFields() {
    if (!this.sender_name?.trim())
      loopar.throw('Name is required');

    if (this.sender_name.length < 2 || this.sender_name.length > 100)
      loopar.throw('Name must be between 2 and 100 characters');

    if (!this.email?.trim())
      loopar.throw('Email is required');

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(this.email))
      loopar.throw('Invalid email address');

    if (!this.subject?.trim())
      loopar.throw('Subject is required');

    if (this.subject.length > 200)
      loopar.throw('Subject must be less than 200 characters');

    if (!this.message?.trim())
      loopar.throw('Message is required');

    if (this.message.length < 10 || this.message.length > 5000)
      loopar.throw('Message must be between 10 and 5000 characters');
  }

  async computeSpamScore(context = {}) {
    const haystack = `${this.sender_name} ${this.subject} ${this.message}`;
    const { score: heuristicScore, hits } = detectSpamHeuristics(haystack);
    let score = heuristicScore;

    // Disposable / throwaway email domains (was a hard reject before; a
    // score keeps borderline-legit senders reviewable under Spam status).
    if (!mailchecker.isValid(this.email)) {
      score += 2;
      hits.push('disposable-email');
    }

    // Gmail dot-abuse: 4+ dots in the local part is virtually always an
    // alias-rotation trick, never a real address someone typed.
    const localPart = String(this.email || '').split('@')[0];
    const domain = String(this.email || '').toLowerCase().split('@')[1] || '';
    if (['gmail.com', 'googlemail.com'].includes(domain) && (localPart.match(/\./g) || []).length >= 4) {
      score += 2;
      hits.push('dotted-email-alias');
    }

    // Same normalized sender already flagged as spam before.
    // +1 (NOT +2): alone it must never reach the Spam threshold — at +2 one
    // false positive permanently blacklists the sender (self-reinforcing loop).
    const previouslyFlagged = await this.countPreviousSpam(normalizeEmail(this.email));
    if (previouslyFlagged > 0) {
      score += 1;
      hits.push('previously-flagged-sender');
    }

    // Submitted faster than a human could fill the form (from controller).
    // Softer when Turnstile positively verified the sender: a real person
    // using browser autofill can legitimately submit in under 3s.
    if (context.fastFill) {
      score += context.humanVerified ? 1 : 2;
      hits.push('fast-fill');
    }

    return { score, hits };
  }

  async countPreviousSpam(normalizedEmail) {
    if (!normalizedEmail) return 0;

    try {
      const result = await loopar.db.rawQuery(
        `SELECT COUNT(*) as count FROM ${loopar.db.tableName('Contact Message')}
         WHERE ${loopar.db.escapeId('normalized_email')} = ?
           AND ${loopar.db.escapeId('status')} = ?`,
        [normalizedEmail, 'Spam']
      );
      return result[0]?.count || 0;
    } catch (error) {
      // Column may not exist yet before the schema migration runs.
      console.warn('[contact-message] countPreviousSpam failed:', error.message);
      return 0;
    }
  }

  async checkRateLimit(maxRequests = 5, windowMinutes = 15) {
    if (!this.ip_address) return;

    const windowStart = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();

    const result = await loopar.db.rawQuery(
      `SELECT COUNT(*) as count FROM ${loopar.db.tableName('Contact Message')}
       WHERE ${loopar.db.escapeId('ip_address')} = ?
         AND ${loopar.db.escapeId('submitted_at')} >= ?`,
      [this.ip_address, windowStart]
    );

    if ((result[0]?.count || 0) >= maxRequests) {
      loopar.throw('Too many requests. Please try again later.');
    }
  }

  sanitizeFields() {
    const sanitize = (str) => {
      if (!str) return '';
      return str.trim().replace(/<[^>]*>/g, '');
    };

    this.sender_name = sanitize(this.sender_name);
    this.email = sanitize(this.email);
    this.phone = sanitize(this.phone || '');
    this.subject = sanitize(this.subject);
    this.message = sanitize(this.message);
  }

  generateId() {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 6);
    return `CM-${timestamp}-${random}`.toUpperCase();
  }

  async notifyAdmin() {
    try {
      // The site's Email Account when it has one, else Email Settings.
      const adminEmail = await loopar.mail.notificationEmail();

      if (!adminEmail) {
        console.warn('No notification email configured');
        return;
      }

      await loopar.mail.send({
        to: adminEmail,
        replyTo: this.email,
        subject: `New Contact: ${this.subject}`,
        html: `
          <h2>New message from ${this.sender_name}</h2>
          <p><strong>Email:</strong> ${this.email}</p>
          <p><strong>Phone:</strong> ${this.phone || 'Not provided'}</p>
          <p><strong>Subject:</strong> ${this.subject}</p>
          <hr>
          <p>${this.message}</p>
        `
      });
    } catch (error) {
      console.error('Failed to notify admin:', error.message);
    }
  }
}
