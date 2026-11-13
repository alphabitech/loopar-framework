import nodemailer from 'nodemailer';
import { loopar } from './loopar.js';
import { shouldRunJobs } from './config/core-config.js';
import { Op } from 'db-env';

const isOn = (v) => [1, '1', true, 'true'].includes(v);

/**
 * Sending goes through Email Settings, except on a multi-site tenant's
 * website domain with an enabled Email Account for its web app: then that
 * account is the sender (and its SMTP login), so each site mails as itself.
 * An account without its own host borrows Email Settings' server.
 */
export class EmailService {
  transporter = null;
  settings = null;
  /** web app → enabled Email Account name (null = not loaded yet). */
  accounts = null;
  accountDocs = new Map();
  /** Pooled transporter per sender account (the default one is `transporter`). */
  transporters = new Map();
  templateCache = new Map();
  isProcessing = false;
  processorInterval = null;

  priorityWeight = {
    'Urgent': 0,
    'High': 1,
    'Normal': 2,
    'Low': 3
  };

  retryDelays = [1, 5, 15, 30, 60];

  async getSettings() {
    if (!this.settings) {
      this.settings = await loopar.getDocument('Email Settings');
    }
    return this.settings;
  }

  /** The enabled Email Account of a web app, or null. */
  async accountFor(app) {
    if (!app) return null;
    if (!this.accounts) {
      const accounts = new Map();
      try {
        const rows = await loopar.db.getAll('Email Account', ['name', 'web_app', 'enabled']);
        for (const r of rows) if (r.web_app && isOn(r.enabled)) accounts.set(r.web_app, r.name);
      } catch (_) { /* entity not installed yet: everything uses Email Settings */ }
      this.accounts = accounts;
    }
    const name = this.accounts.get(app);
    if (!name) return null;
    if (!this.accountDocs.has(name)) this.accountDocs.set(name, await loopar.getDocument('Email Account', name));
    return this.accountDocs.get(name);
  }

  /** Plain settings for an account: its sender and login over Email Settings' server and limits. */
  async mergeAccount(account) {
    const base = await this.getSettings();
    const ownHost = String(account.host || '').trim();
    const secure = ownHost ? (isOn(account.secure) ? 1 : 0) : base.secure;
    return {
      host: ownHost || base.host,
      port: ownHost ? (parseInt(account.port) || (secure ? 465 : 587)) : base.port,
      secure,
      auth_enabled: 1,
      user: String(account.user || '').trim() || account.name,
      password: account.password,
      timeout: base.timeout,
      max_connections: base.max_connections,
      rate_limit: base.rate_limit,
      debug: base.debug,
      from_name: account.from_name || base.from_name,
      from_email: account.name,
      reply_to: account.reply_to || '',
      notification_email: account.notification_email || base.notification_email || base.from_email || '',
      account: account.name,
    };
  }

  /**
   * Settings to send with: the account of `app` (default: the website domain
   * serving this request) when there is one, else Email Settings.
   */
  async resolve(app = loopar.requestSite) {
    const account = await this.accountFor(app);
    return account ? this.mergeAccount(account) : this.getSettings();
  }

  /** Where contact forms of `app` (default: this request's site) are delivered. */
  async notificationEmail(app = loopar.requestSite) {
    const s = await this.resolve(app);
    return s.notification_email || s.from_email || '';
  }

  /** True when there is an SMTP server to send through for `app`. */
  async hasTransport(app = loopar.requestSite) {
    return !!(await this.resolve(app))?.host;
  }

  buildTransportOptions(settings) {
    return {
      host: settings.host,
      port: parseInt(settings.port),
      secure: settings.secure == 1,
      auth: settings.auth_enabled == 1 ? {
        user: settings.user,
        pass: settings.password
      } : undefined,
      connectionTimeout: parseInt(settings.timeout) || 5000,
      pool: true,
      maxConnections: parseInt(settings.max_connections) || 5,
      rateDelta: 1000,
      rateLimit: parseInt(settings.rate_limit) || 10,
      debug: settings.debug == 1,
      logger: settings.debug == 1
    };
  }

  async getTransporter(settings, force) {
    if (settings?.account) {
      if (!this.transporters.has(settings.account) || force) {
        this.transporters.set(settings.account, nodemailer.createTransport(this.buildTransportOptions(settings)));
      }
      return this.transporters.get(settings.account);
    }

    settings ??= await this.getSettings();

    if (!this.transporter || force) {
      this.transporter = nodemailer.createTransport(this.buildTransportOptions(settings));
    }

    return this.transporter;
  }

  parseTemplate(text, variables = {}) {
    if (!text) return '';
    
    return text.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (match, key) => {
      const value = key.split('.').reduce((obj, k) => obj?.[k], variables);
      return value !== undefined ? value : match;
    });
  }

  async getTemplate(templateName) {
    if (this.templateCache.has(templateName)) {
      return this.templateCache.get(templateName);
    }

    try {
      const template = await loopar.getDocument('Email Template', templateName);
      
      if (!template.enabled) {
        throw new Error(`Template "${templateName}" is disabled`);
      }
      
      this.templateCache.set(templateName, template);
      return template;
    } catch (error) {
      throw new Error(`Template "${templateName}" not found`);
    }
  }

  /**
   * Sends one email immediately (no queue).
   */
  async send({ to, subject, html, text, attachments = [], cc, bcc, replyTo, app }) {
    const settings = await this.resolve(app);
    const transporter = await this.getTransporter(settings);

    const mailOptions = {
      from: `"${settings.from_name}" <${settings.from_email}>`,
      to: Array.isArray(to) ? to.join(', ') : to,
      subject,
      html,
      text: text || html?.replace(/<[^>]*>/g, ''),
      replyTo: replyTo || settings.reply_to || undefined,
      cc,
      bcc,
      attachments
    };

    const result = await transporter.sendMail(mailOptions);
    return { success: true, messageId: result.messageId };
  }

  async sendTemplate({ template, to, variables = {}, attachments = [], cc, bcc, replyTo, app }) {
    try {
      const tpl = await this.getTemplate(template);
      
      const subject = this.parseTemplate(tpl.subject, variables);
      const html = this.parseTemplate(tpl.body, variables);

      return await this.send({
        to,
        subject,
        html,
        attachments,
        cc,
        bcc,
        replyTo,
        app
      });
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  generateQueueId() {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 8);
    return `EQ-${timestamp}-${random}`.toUpperCase();
  }

  async queue({
    to,
    subject,
    html,
    template,
    variables = {},
    attachments = [],
    cc,
    bcc,
    priority = 'Normal',
    scheduledAt = null,
    maxAttempts = 3
  }) {
    try {
      let finalSubject = subject;
      let finalHtml = html;

      if (template) {
        const tpl = await this.getTemplate(template);
        finalSubject = this.parseTemplate(tpl.subject, variables);
        finalHtml = this.parseTemplate(tpl.body, variables);
      }

      const queueEntry = await loopar.newDocument('Email Queue');
      
      queueEntry.name = this.generateQueueId();
      queueEntry.to = Array.isArray(to) ? to.join(', ') : to;
      queueEntry.subject = finalSubject;
      queueEntry.html = finalHtml;
      queueEntry.template = template || '';
      queueEntry.variables = Object.keys(variables).length ? JSON.stringify(variables) : '';
      queueEntry.attachments = attachments.length ? JSON.stringify(attachments) : '';
      queueEntry.cc = cc || '';
      queueEntry.bcc = bcc || '';
      queueEntry.priority = priority;
      queueEntry.status = 'Pending';
      queueEntry.attempts = 0;
      queueEntry.max_attempts = maxAttempts;
      queueEntry.scheduled_at = scheduledAt;

      await queueEntry.save();

      return { success: true, queueId: queueEntry.name };
    } catch (error) {
      console.error('Queue error:', error);
      return { success: false, error: error.message };
    }
  }

  async queueBulk(emails, defaultOptions = {}) {
    const results = [];
    
    for (const email of emails) {
      const result = await this.queue({
        ...defaultOptions,
        ...email
      });
      results.push(result);
    }

    return {
      success: true,
      total: emails.length,
      queued: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      results
    };
  }

  async processQueueItem(item) {
    try {
      item.status = 'Processing';
      item.attempts = (parseInt(item.attempts) || 0) + 1;
      await item.save();

      const attachments = item.attachments ? JSON.parse(item.attachments) : [];

      const result = await this.send({
        to: item.to,
        subject: item.subject,
        html: item.html,
        cc: item.cc || undefined,
        bcc: item.bcc || undefined,
        attachments
      });

      if (result.success) {
        item.status = 'Sent';
        item.sent_at = new Date().toISOString();
        item.message_id = result.messageId;
        item.error_log = '';
      } else {
        throw new Error(result.error);
      }

      await item.save();
      return { success: true, id: item.name };

    } catch (error) {
      const attempts = parseInt(item.attempts) || 0;
      const maxAttempts = parseInt(item.max_attempts) || 3;

      const errorLog = item.error_log || '';
      const timestamp = new Date().toISOString();
      item.error_log = `${errorLog}[${timestamp}] Attempt ${attempts}: ${error.message}\n`;

      if (attempts >= maxAttempts) {
        item.status = 'Failed';
      } else {
        item.status = 'Pending';
        const delayMinutes = this.retryDelays[Math.min(attempts - 1, this.retryDelays.length - 1)];
        const nextRetry = new Date(Date.now() + delayMinutes * 60 * 1000);
        item.next_retry_at = nextRetry.toISOString();
      }

      await item.save();
      return { success: false, id: item.name, error: error.message };
    }
  }

  async processQueue(limit = 10) {
    if (this.isProcessing) {
      return { success: false, message: 'Queue is already being processed' };
    }

    this.isProcessing = true;
    const results = [];

    try {
      // date_time fields are stored as local "yyyy-MM-dd HH:mm:ss": compare in that form.
      const now = loopar.dateUtils.getDateTime(new Date(), 'DB');

      // Due = pending, and both its schedule and its next retry (when set) have come.
      const due = (field) => ({ [Op.or]: [{ [field]: null }, { [field]: '' }, { [field]: { [Op.lte]: now } }] });
      const pendingEmails = await loopar.db.getAll('Email Queue', ['name', 'priority'], {
        status: 'Pending',
        [Op.and]: [due('scheduled_at'), due('next_retry_at')],
      });

      const sortedIds = pendingEmails.sort((a, b) => {
        return (this.priorityWeight[a.priority] ?? 2) - (this.priorityWeight[b.priority] ?? 2);
      }).slice(0, limit);

      for (const { name } of sortedIds) {
        const item = await loopar.getDocument('Email Queue', name);
        const result = await this.processQueueItem(item);
        results.push(result);
      }

      return {
        success: true,
        processed: results.length,
        sent: results.filter(r => r.success).length,
        failed: results.filter(r => !r.success).length,
        results
      };

    } catch (error) {
      console.error('Process queue error:', error);
      return { success: false, error: error.message };
    } finally {
      this.isProcessing = false;
    }
  }

  startQueueProcessor(intervalMs = 60000) {
    // Cluster: only the jobs worker runs the processor so N workers don't each
    // send the same queued mail. Single process -> always runs.
    if (!shouldRunJobs()) {
      console.log('[Email] queue processor skipped (not the jobs worker)');
      return;
    }
    if (this.processorInterval) {
      console.log('Queue processor already running');
      return;
    }

    console.log(`📧 Email queue processor started (interval: ${intervalMs}ms)`);
    
    this.processorInterval = setInterval(async () => {
      const result = await this.processQueue();
      if (result.processed > 0) {
        console.log(`📧 Processed ${result.processed} emails (${result.sent} sent, ${result.failed} failed)`);
      }
    }, intervalMs);

    this.processQueue();
  }

  stopQueueProcessor() {
    if (this.processorInterval) {
      clearInterval(this.processorInterval);
      this.processorInterval = null;
      console.log('📧 Email queue processor stopped');
    }
  }

  async getQueueStats() {
    const stats = {};
    
    for (const status of ['Pending', 'Processing', 'Sent', 'Failed', 'Cancelled']) {
      stats[status.toLowerCase()] = await loopar.db.count('Email Queue', { status });
    }

    stats.total = Object.values(stats).reduce((a, b) => a + b, 0);
    
    return stats;
  }

  async retryFailed(ids = null) {
    const filter = { status: 'Failed' };

    if (ids && ids.length) {
      filter.name = ids;
    }

    const failed = await loopar.db.getAll('Email Queue', ['name'], filter);
    let updated = 0;

    for (const { name } of failed) {
      const item = await loopar.getDocument('Email Queue', name);
      item.status = 'Pending';
      item.attempts = 0;
      item.next_retry_at = null;
      await item.save();
      updated++;
    }

    return { success: true, updated };
  }

  async cancelPending(ids) {
    let cancelled = 0;

    for (const id of ids) {
      try {
        const item = await loopar.getDocument('Email Queue', id);
        if (item.status === 'Pending') {
          item.status = 'Cancelled';
          await item.save();
          cancelled++;
        }
      } catch (e) {
      }
    }

    return { success: true, cancelled };
  }

  async cleanOldEmails(daysOld = 30) {
    // __created_at__ is stored by the database clock as "YYYY-MM-DD HH:MM:SS".
    const cutoffDate = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');

    const oldEmails = await loopar.db.getAll('Email Queue', ['name'], {
      __created_at__: { [Op.lte]: cutoffDate },
      status: ['Sent', 'Failed', 'Cancelled'],
    });

    let deleted = 0;
    for (const { name } of oldEmails) {
      await loopar.deleteDocument('Email Queue', name, { sofDelete: false }); // a purge, not a trash
      deleted++;
    }

    return { success: true, deleted };
  }

  async testConnection(data) {
    // Use a throwaway transporter built from the supplied (possibly unsaved)
    // settings so we never reuse or clobber the shared production transporter.
    const settings = data ?? await this.getSettings();
    const transporter = nodemailer.createTransport(this.buildTransportOptions(settings));
    try {
      await transporter.verify();
      return { success: true, message: 'Connection successful' };
    } catch (error) {
      return { success: false, error: error.message };
    } finally {
      transporter.close();
    }
  }

  /**
   * Sends a real message with the supplied (possibly unsaved) settings. A
   * login can succeed and the server still refuse the sender address, so
   * this is the check that proves mail actually leaves.
   */
  async sendTest(data, to) {
    const settings = data ?? await this.getSettings();
    const transporter = nodemailer.createTransport({ ...this.buildTransportOptions(settings), pool: false });
    try {
      const result = await transporter.sendMail({
        from: `"${settings.from_name || 'Loopar'}" <${settings.from_email}>`,
        to,
        subject: 'Loopar test email',
        text: `This is a test email sent from ${settings.from_email} through ${settings.host}. If you are reading it, outgoing mail works.`,
      });
      return { success: true, messageId: result.messageId, accepted: result.accepted || [] };
    } catch (error) {
      return { success: false, error: error.message };
    } finally {
      transporter.close();
    }
  }

  async previewTemplate(templateName, variables = {}) {
    const template = await this.getTemplate(templateName);
    
    return {
      subject: this.parseTemplate(template.subject, variables),
      html: this.parseTemplate(template.body, variables)
    };
  }

  reset() {
    this.transporter = null;
    this.transporters.clear();
    this.settings = null;
    this.accounts = null;
    this.accountDocs.clear();
    this.templateCache.clear();
  }
}