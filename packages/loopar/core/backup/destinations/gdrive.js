'use strict';

/**
 * Google Drive destination through the REST API (no SDK), with the
 * `drive.file` scope: Loopar only sees the files it created. Backups go to
 * a "Loopar Backups" folder (or the folder id configured), named
 * `<tenant>__…`. Credentials: an OAuth client (id + secret) of the admin's
 * Google Cloud project and the refresh token obtained with "Connect Google
 * Drive" on the Backups page (authUrl → exchangeCode).
 */

import { request, expectOk } from './http.js';

const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
export const GDRIVE_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/drive.file'];
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const FOLDER_NAME = 'Loopar Backups';

const form = (obj) => new URLSearchParams(obj).toString();
const json = (res) => JSON.parse(res.body.toString('utf8') || '{}');

/** Consent URL for "Connect Google Drive" (offline access → refresh token). */
export function gdriveAuthUrl({ clientId, redirectUri, state }) {
  const u = new URL(AUTH);
  u.search = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: 'code',
    scope: GDRIVE_SCOPES.join(' '), access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state,
  }).toString();
  return u.toString();
}

/** Exchange the consent code: { refreshToken, account }. */
export async function gdriveExchangeCode({ clientId, clientSecret, redirectUri, code }) {
  const res = expectOk(await request({
    method: 'POST', url: TOKEN, headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
  }), 'Google token exchange');
  const data = json(res);
  if (!data.refresh_token) throw new Error('Google did not return a refresh token. Remove Loopar from your Google account permissions and connect again.');
  let account = '';
  try { account = JSON.parse(Buffer.from(String(data.id_token).split('.')[1], 'base64url').toString('utf8')).email || ''; } catch { /* optional */ }
  return { refreshToken: data.refresh_token, account };
}

export class GdriveDestination {
  name = 'gdrive';
  #token = null;
  #tokenExp = 0;
  #folder = null;

  constructor(s) {
    if (!s.gdrive_client_id || !s.gdrive_client_secret) throw new Error('Google Drive destination: OAuth client id and secret are required.');
    if (!s.gdrive_refresh_token) throw new Error('Google Drive destination: not connected yet — use "Connect Google Drive" on the Backups page.');
    this.s = s;
    this.#folder = s.gdrive_folder_id || null;
  }

  async #accessToken() {
    if (this.#token && Date.now() < this.#tokenExp) return this.#token;
    const res = expectOk(await request({
      method: 'POST', url: TOKEN, headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ client_id: this.s.gdrive_client_id, client_secret: this.s.gdrive_client_secret, refresh_token: this.s.gdrive_refresh_token, grant_type: 'refresh_token' }),
    }), 'Google token refresh');
    const data = json(res);
    this.#token = data.access_token;
    this.#tokenExp = Date.now() + Math.max(60, (data.expires_in || 3600) - 120) * 1000;
    return this.#token;
  }

  async #api(method, url, { headers = {}, body, toFile } = {}) {
    const token = await this.#accessToken();
    return await request({ method, url, headers: { authorization: `Bearer ${token}`, ...headers }, body, toFile });
  }

  async #folderId() {
    if (this.#folder) return this.#folder;
    const q = `name = '${FOLDER_NAME}' and mimeType = '${FOLDER_MIME}' and trashed = false`;
    const found = json(expectOk(await this.#api('GET', `${API}/files?${form({ q, fields: 'files(id)', pageSize: '1', spaces: 'drive' })}`), 'Google Drive folder lookup'));
    if (found.files?.[0]?.id) return (this.#folder = found.files[0].id);
    const created = json(expectOk(await this.#api('POST', `${API}/files?fields=id`, {
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: FOLDER_NAME, mimeType: FOLDER_MIME }),
    }), 'Google Drive create folder'));
    return (this.#folder = created.id);
  }

  async #find(tenant, file) {
    const all = await this.#files(tenant);
    return all.find((f) => f.name === file) || null;
  }

  async #files(tenant) {
    const folder = await this.#folderId();
    const q = `'${folder}' in parents and trashed = false and name contains '${String(tenant).replace(/'/g, "\\'")}__'`;
    const out = [];
    let pageToken;
    do {
      const data = json(expectOk(await this.#api('GET', `${API}/files?${form({ q, fields: 'nextPageToken,files(id,name,size,modifiedTime)', pageSize: '1000', ...(pageToken ? { pageToken } : {}) })}`), 'Google Drive list'));
      out.push(...(data.files || []));
      pageToken = data.nextPageToken;
    } while (pageToken);
    return out.filter((f) => f.name.startsWith(`${tenant}__`));
  }

  async upload(localFile, tenant, file) {
    const folder = await this.#folderId();
    const existing = await this.#find(tenant, file);
    const init = await this.#api(existing ? 'PATCH' : 'POST', existing ? `${UPLOAD}/${existing.id}?uploadType=resumable` : `${UPLOAD}?uploadType=resumable`, {
      headers: { 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-type': 'application/octet-stream' },
      body: JSON.stringify(existing ? {} : { name: file, parents: [folder] }),
    });
    expectOk(init, 'Google Drive upload (start)');
    const session = init.headers.location;
    if (!session) throw new Error('Google Drive did not return an upload session.');
    expectOk(await request({ method: 'PUT', url: session, headers: { 'content-type': 'application/octet-stream' }, body: { file: localFile } }), 'Google Drive upload');
  }

  async download(tenant, file, localFile) {
    const f = await this.#find(tenant, file);
    if (!f) throw new Error(`${file} is not in Google Drive.`);
    expectOk(await this.#api('GET', `${API}/files/${f.id}?alt=media`, { toFile: localFile }), 'Google Drive download');
  }

  async remove(tenant, file) {
    const f = await this.#find(tenant, file);
    if (!f) return;
    const res = await this.#api('DELETE', `${API}/files/${f.id}`);
    if (res.status !== 404) expectOk(res, 'Google Drive delete');
  }

  async list(tenant) {
    return (await this.#files(tenant)).map((f) => ({ file: f.name, size: Number(f.size) || 0, modifiedAt: f.modifiedTime || null }));
  }
}
