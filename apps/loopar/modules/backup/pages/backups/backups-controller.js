'use strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { PageController, loopar } from 'loopar';
import {
  fetchBackup, deleteBackup, importBackup, startBackupJob, startRestoreJob, backupJob, isRestoring,
  gdriveAuthUrl, gdriveExchangeCode, parseBackupName, inspectBackup,
} from 'loopar/core/backup/index.js';
import { backupSettings, saveSettingsFields, tenantName } from '../../backup-service.js';
import { pageData } from '../../backup-page-data.js';

const GDRIVE_STATE_COOKIE = 'lp_gdrive_state';

/** Every publicAction<X> a class inherits (PageController ships reviews, galleries, forms…). */
function inheritedPublicActions(cls) {
  const names = new Set();
  for (let proto = cls.prototype; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (key.startsWith('publicAction') && key.length > 12) names.add(key.slice(12));
    }
  }
  return [...names];
}

/**
 * Backups of the current site. Listing, creating and downloading follow the
 * regular permissions; restoring, deleting and connecting a destination are
 * reserved to the Administrator (they replace or expose the whole site).
 * Payloads are wrapped (`rows`, `job`…): `status`/`message` belong to the
 * response envelope.
 */
export default class BackupsController extends PageController {
  defaultAction = 'view';
  static postOnlyActions = ['backupNow', 'restore', 'remove', 'upload', 'gdriveConnect', 'gdriveDisconnect'];

  static get revokedPublicActions() {
    return inheritedPublicActions(this);
  }

  constructor(props) {
    super(props);
  }

  get input() {
    return { ...(this.query || {}), ...(this.data || {}) };
  }

  #requireAdministrator() {
    if (loopar.auth?.user?.() !== 'Administrator') {
      loopar.throw({ code: 403, title: 'Forbidden', message: 'Only the Administrator can do this.' });
    }
  }

  #file() {
    const file = String(this.input.file || '');
    if (!parseBackupName(file)) loopar.throw({ code: 400, message: 'Invalid backup file.' });
    return file;
  }

  async actionView() {
    const view = await loopar.newDocument('Backups');
    return await this.render(view);
  }

  /** Page data, including the remote destination's listing. */
  async actionList() {
    return { page: await pageData({ remote: true }) };
  }

  async actionStatus() {
    return { job: backupJob(tenantName()), restoring: isRestoring(tenantName()) };
  }

  async actionBackupNow() {
    const job = startBackupJob({ tenant: tenantName(), settings: await backupSettings() });
    return { job };
  }

  /** Download one backup (fetched from the destination when it's only there). */
  async actionDownload() {
    // The archive holds the site's secrets (config.json) and its whole database.
    this.#requireAdministrator();
    const file = this.#file();
    const p = await fetchBackup({ tenant: tenantName(), file, settings: await backupSettings() });
    await new Promise((resolve, reject) => this.res.download(p, file, (e) => (e ? reject(e) : resolve())));
    return { downloaded: file };
  }

  async actionInspect() {
    this.#requireAdministrator();
    const file = this.#file();
    const settings = await backupSettings();
    const p = await fetchBackup({ tenant: tenantName(), file, settings });
    const manifest = await inspectBackup({ file: p, passphrase: this.input.passphrase || settings.passphrase });
    return { manifest };
  }

  /** Keep an archive made elsewhere (another server, an earlier download) to restore it here. */
  async actionUpload() {
    this.#requireAdministrator();
    const files = this.data?.__REQ_FILES__ || this.__REQ_FILES__ || [];
    const f = files[0];
    if (!f?.buffer) loopar.throw({ code: 400, message: 'Choose a backup archive to upload.' });
    const tmp = path.join(os.tmpdir(), `loopar-upload-${crypto.randomBytes(6).toString('hex')}`);
    try {
      await fs.promises.writeFile(tmp, f.buffer);
      const { file } = await importBackup({ tenant: tenantName(), source: tmp, originalName: f.originalname });
      return { uploaded: file };
    } finally {
      await fs.promises.rm(tmp, { force: true });
    }
  }

  async actionRemove() {
    this.#requireAdministrator();
    const file = this.#file();
    const where = ['local', 'remote', 'both'].includes(this.input.where) ? this.input.where : 'both';
    await deleteBackup({ tenant: tenantName(), file, where, settings: await backupSettings() });
    return { removed: file };
  }

  /**
   * Restore a backup over THIS site, in the background: a pre-restore
   * snapshot first, then the site answers "restoring" until it re-opens on
   * the restored data. The client confirms by typing the site name.
   */
  async actionRestore() {
    this.#requireAdministrator();
    const tenant = tenantName();
    const file = this.#file();
    if (String(this.input.confirm || '').trim() !== tenant) {
      loopar.throw({ code: 400, message: `Type the site name (${tenant}) to confirm the restore.` });
    }
    const settings = await backupSettings();
    const job = startRestoreJob({ tenant, file, passphrase: this.input.passphrase || undefined, settings });
    return { job };
  }

  // ─── Google Drive connection (OAuth, offline access) ────────────────────────

  #redirectUri() {
    const req = this.req;
    const proto = req.secure ? 'https' : 'http';
    return `${proto}://${req.headers.host}/desk/Backups/gdriveCallback`;
  }

  async actionGdriveConnect() {
    this.#requireAdministrator();
    const s = await backupSettings();
    if (!s.gdrive_client_id || !s.gdrive_client_secret) {
      loopar.throw({ code: 400, message: 'Save the Google OAuth client ID and secret in Backup Settings first.' });
    }
    const state = crypto.randomBytes(16).toString('hex');
    loopar.cookie.set(GDRIVE_STATE_COOKIE, state, { httpOnly: true, path: '/', maxAge: 10 * 60 * 1000 });
    return { url: gdriveAuthUrl({ clientId: s.gdrive_client_id, redirectUri: this.#redirectUri(), state }), redirectUri: this.#redirectUri() };
  }

  /** Google sends the admin back here (a desk GET) with ?code&state. */
  async actionGdriveCallback() {
    this.#requireAdministrator();
    const { code, state, error } = this.query || {};
    const expected = loopar.cookie.get(GDRIVE_STATE_COOKIE);
    loopar.cookie.remove(GDRIVE_STATE_COOKIE, { path: '/' });
    if (error) return this.redirect('/desk/Backups/view?gdrive=denied');
    if (!code || !state || !expected || String(state) !== expected) {
      loopar.throw({ code: 400, message: 'Google Drive connection expired or was not started here. Try again.' });
    }
    const s = await backupSettings();
    const { refreshToken, account } = await gdriveExchangeCode({
      clientId: s.gdrive_client_id, clientSecret: s.gdrive_client_secret, redirectUri: this.#redirectUri(), code: String(code),
    });
    await saveSettingsFields({ gdrive_refresh_token: refreshToken, gdrive_account: account });
    return this.redirect('/desk/Backups/view?gdrive=connected');
  }

  async actionGdriveDisconnect() {
    this.#requireAdministrator();
    await saveSettingsFields({ gdrive_refresh_token: '', gdrive_account: '' });
    return { disconnected: true };
  }
}
