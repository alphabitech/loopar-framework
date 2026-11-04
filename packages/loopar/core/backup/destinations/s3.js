'use strict';

/**
 * S3-compatible destination: AWS S3, Cloudflare R2, Backblaze B2, DigitalOcean
 * Spaces, MinIO, Wasabi, Google Cloud Storage (interoperability/HMAC keys).
 * Signature V4 implemented here (no SDK); bodies are sent as UNSIGNED-PAYLOAD
 * over HTTPS so archives stream from disk. Single PUT: archives up to 5 GB.
 *
 *   endpoint empty → AWS, virtual-hosted (https://<bucket>.s3.<region>.amazonaws.com)
 *   endpoint set   → path-style (https://<endpoint>/<bucket>/<key>)
 */

import crypto from 'node:crypto';
import { request, expectOk, checkBaseUrl, xmlBlocks, xmlText, unescapeXml } from './http.js';

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const encPath = (p) => p.split('/').map(enc).join('/');

/**
 * SigV4 headers for one request (exported for tests against AWS's examples).
 * @returns {object} headers including Authorization
 */
export function signV4({ method, url, region, accessKey, secretKey, headers = {}, payloadHash = 'UNSIGNED-PAYLOAD', service = 's3', date = new Date() }) {
  const u = new URL(url);
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const h = { ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()])), host: u.host, 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash };
  const names = Object.keys(h).sort();
  const canonicalHeaders = names.map((n) => `${n}:${h[n]}\n`).join('');
  const signedHeaders = names.join(';');
  const query = [...u.searchParams.entries()].map(([k, v]) => [enc(k), enc(v)]).sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('&');
  const canonical = [method, encPath(decodeURIComponent(u.pathname)) || '/', query, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, day), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', key).update(toSign).digest('hex');
  return { ...h, authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` };
}

export class S3Destination {
  name = 's3';

  constructor(s) {
    for (const k of ['s3_bucket', 's3_access_key', 's3_secret_key']) if (!s[k]) throw new Error(`S3 destination: "${k}" is required.`);
    this.bucket = s.s3_bucket;
    this.region = s.s3_region || 'us-east-1';
    this.accessKey = s.s3_access_key;
    this.secretKey = s.s3_secret_key;
    this.prefix = String(s.s3_prefix || '').replace(/^\/+|\/+$/g, '');
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(this.bucket)) throw new Error('S3 destination: not a valid bucket name.');
    if (!/^[a-z0-9-]+$/.test(this.region)) throw new Error('S3 destination: not a valid region.');
    const ep = String(s.s3_endpoint || '').trim().replace(/\/+$/, '');
    this.base = ep
      ? `${checkBaseUrl(/^https?:\/\//.test(ep) ? ep : `https://${ep}`, 'S3 destination (endpoint)')}/${this.bucket}`
      : `https://${this.bucket}.s3.${this.region}.amazonaws.com`;
  }

  #key(tenant, file = '') {
    return [this.prefix, tenant, file].filter(Boolean).join('/');
  }

  async #send(method, key, { query = {}, headers = {}, body, toFile } = {}) {
    const url = new URL(`${this.base}/${encPath(key)}`);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) url.searchParams.set(k, v);
    const signed = signV4({ method, url, region: this.region, accessKey: this.accessKey, secretKey: this.secretKey, headers });
    return await request({ method, url, headers: signed, body, toFile });
  }

  async upload(localFile, tenant, file) {
    expectOk(await this.#send('PUT', this.#key(tenant, file), { body: { file: localFile }, headers: { 'content-type': 'application/octet-stream' } }), 'S3 upload');
  }

  async download(tenant, file, localFile) {
    expectOk(await this.#send('GET', this.#key(tenant, file), { toFile: localFile }), 'S3 download');
  }

  async remove(tenant, file) {
    const res = await this.#send('DELETE', this.#key(tenant, file));
    if (res.status !== 404) expectOk(res, 'S3 delete');
  }

  async list(tenant) {
    const out = [];
    const prefix = `${this.#key(tenant)}/`;
    let token;
    do {
      const res = expectOk(await this.#send('GET', '', { query: { 'list-type': '2', prefix, 'continuation-token': token } }), 'S3 list');
      const xml = res.body.toString('utf8');
      for (const block of xmlBlocks(xml, 'Contents')) {
        const key = unescapeXml(xmlText(block, 'Key'));
        out.push({ file: key.slice(prefix.length), size: Number(xmlText(block, 'Size')) || 0, modifiedAt: xmlText(block, 'LastModified') });
      }
      token = xmlText(xml, 'IsTruncated') === 'true' ? unescapeXml(xmlText(xml, 'NextContinuationToken')) : null;
    } while (token);
    return out.filter((f) => f.file && !f.file.includes('/'));
  }
}
