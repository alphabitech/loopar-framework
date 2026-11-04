'use strict';

/**
 * WebDAV destination: Nextcloud, ownCloud, Synology/QNAP, Box, pCloud,
 * Koofr… `webdav_url` is the folder that holds the backups, e.g.
 * https://cloud.example.com/remote.php/dav/files/<user>/loopar-backups
 */

import { request, expectOk, checkBaseUrl, xmlBlocks, xmlText, unescapeXml } from './http.js';

export class WebdavDestination {
  name = 'webdav';

  constructor(s) {
    if (!s.webdav_url) throw new Error('WebDAV destination: the folder URL is required.');
    this.base = checkBaseUrl(String(s.webdav_url).trim(), 'WebDAV destination');
    this.auth = s.webdav_username
      ? `Basic ${Buffer.from(`${s.webdav_username}:${s.webdav_password || ''}`).toString('base64')}`
      : null;
  }

  #url(...parts) {
    return [this.base, ...parts.map(encodeURIComponent)].join('/');
  }

  #headers(extra = {}) {
    return { ...(this.auth ? { authorization: this.auth } : {}), ...extra };
  }

  async #ensureFolder(tenant) {
    // Base folder first, then the tenant's. 405 = already exists.
    for (const url of [`${this.base}/`, `${this.#url(tenant)}/`]) {
      const res = await request({ method: 'MKCOL', url, headers: this.#headers() });
      if (![201, 405, 301, 200].includes(res.status)) expectOk(res, 'WebDAV create folder');
    }
  }

  async upload(localFile, tenant, file) {
    await this.#ensureFolder(tenant);
    expectOk(await request({ method: 'PUT', url: this.#url(tenant, file), headers: this.#headers({ 'content-type': 'application/octet-stream' }), body: { file: localFile } }), 'WebDAV upload');
  }

  async download(tenant, file, localFile) {
    expectOk(await request({ method: 'GET', url: this.#url(tenant, file), headers: this.#headers(), toFile: localFile }), 'WebDAV download');
  }

  async remove(tenant, file) {
    const res = await request({ method: 'DELETE', url: this.#url(tenant, file), headers: this.#headers() });
    if (res.status !== 404) expectOk(res, 'WebDAV delete');
  }

  async list(tenant) {
    const body = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getcontentlength/><d:getlastmodified/><d:resourcetype/></d:prop></d:propfind>';
    const res = await request({ method: 'PROPFIND', url: `${this.#url(tenant)}/`, headers: this.#headers({ depth: '1', 'content-type': 'application/xml' }), body });
    if (res.status === 404) return [];
    expectOk(res, 'WebDAV list');
    const out = [];
    for (const block of xmlBlocks(res.body.toString('utf8'), 'response')) {
      if (/<(?:[\w-]+:)?collection\s*\/?>/i.test(block)) continue;
      const href = unescapeXml(xmlText(block, 'href') || '');
      const file = decodeURIComponent(href.replace(/\/+$/, '').split('/').pop() || '');
      if (!file) continue;
      const modified = xmlText(block, 'getlastmodified');
      out.push({ file, size: Number(xmlText(block, 'getcontentlength')) || 0, modifiedAt: modified ? new Date(modified).toISOString() : null });
    }
    return out;
  }
}
