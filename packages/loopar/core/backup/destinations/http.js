'use strict';

/**
 * Minimal HTTP(S) client for the backup destinations: streams request bodies
 * from files (with an explicit Content-Length, which fetch can't send for a
 * stream) and streams responses to files. Follows redirects on GET/HEAD.
 */

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import { pipeline } from 'node:stream/promises';

const TIMEOUT_MS = 10 * 60 * 1000;

// Cloud metadata services: never a backup destination, always a credential leak.
// (Private networks stay allowed: a NAS or a MinIO on the LAN is a normal target.)
const BLOCKED = [/^169\.254\./, /^100\.100\.100\.200$/, /^fe80:/i, /^fd00:ec2::254$/i, /^::ffff:169\.254\./i];
const blockedAddress = (a) => BLOCKED.some((re) => re.test(a));
function guardedLookup(hostname, options, cb) {
  dns.lookup(hostname, options, (err, address, family) => {
    if (err) return cb(err);
    const list = Array.isArray(address) ? address : [{ address, family }];
    const bad = list.find((x) => blockedAddress(x.address));
    if (bad) return cb(Object.assign(new Error(`Refusing to connect to ${hostname} (${bad.address}).`), { code: 'EBLOCKED' }));
    cb(null, address, family);
  });
}

/** A destination base URL: http(s), no credentials, query or fragment. */
export function checkBaseUrl(raw, label) {
  let u;
  try { u = new URL(raw); } catch { throw new Error(`${label}: not a valid URL.`); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) {
    throw new Error(`${label}: use a plain http(s) URL (no credentials, "?" or "#").`);
  }
  if (blockedAddress(u.hostname.replace(/^\[|\]$/g, ''))) throw new Error(`${label}: that address is not allowed.`);
  return u.href.replace(/\/+$/, '');
}

/**
 * @param {object} o
 * @param {string} o.method
 * @param {string|URL} o.url
 * @param {object} [o.headers]
 * @param {Buffer|string|{file:string}} [o.body]   a {file} is streamed
 * @param {string} [o.toFile]   write the response body to this file (2xx only)
 * @returns {Promise<{ status:number, headers:object, body:Buffer }>}
 */
export function request({ method = 'GET', url, headers = {}, body, toFile, redirects = 3 }) {
  const u = new URL(url);
  const lib = u.protocol === 'http:' ? http : https;
  const h = { ...headers };
  let size = null;
  if (body && typeof body === 'object' && 'file' in body) size = fs.statSync(body.file).size;
  else if (body !== undefined && body !== null) size = Buffer.byteLength(body);
  if (size !== null && h['content-length'] === undefined && h['Content-Length'] === undefined) h['content-length'] = String(size);

  return new Promise((resolve, reject) => {
    const req = lib.request(u, { method, headers: h, timeout: TIMEOUT_MS, lookup: guardedLookup }, async (res) => {
      const status = res.statusCode;
      if ([301, 302, 303, 307, 308].includes(status) && res.headers.location && redirects > 0 && ['GET', 'HEAD'].includes(method)) {
        res.resume();
        const next = new URL(res.headers.location, u);
        if (!['http:', 'https:'].includes(next.protocol)) { reject(new Error(`Refusing a redirect to ${next.protocol}`)); return; }
        // Credentials stay with the host they were meant for (signed URLs carry their own).
        const fwd = next.host === u.host ? headers
          : Object.fromEntries(Object.entries(headers).filter(([k]) => !/^(authorization|cookie|x-amz-)/i.test(k)));
        resolve(request({ method, url: next, headers: fwd, toFile, redirects: redirects - 1 }));
        return;
      }
      try {
        if (toFile && status >= 200 && status < 300) {
          await pipeline(res, fs.createWriteStream(toFile));
          resolve({ status, headers: res.headers, body: Buffer.alloc(0) });
          return;
        }
        const chunks = [];
        for await (const c of res) chunks.push(c);
        resolve({ status, headers: res.headers, body: Buffer.concat(chunks) });
      } catch (e) {
        reject(e);
      }
    });
    req.on('timeout', () => req.destroy(new Error(`Request to ${u.host} timed out`)));
    req.on('error', reject);
    if (body && typeof body === 'object' && 'file' in body) {
      fs.createReadStream(body.file).on('error', (e) => req.destroy(e)).pipe(req);
    } else {
      if (body !== undefined && body !== null) req.write(body);
      req.end();
    }
  });
}

/** Throw a readable error for a non-2xx response. */
export function expectOk(res, what) {
  if (res.status >= 200 && res.status < 300) return res;
  const text = res.body?.toString('utf8').replace(/\s+/g, ' ').slice(0, 300) || '';
  const err = new Error(`${what} failed (HTTP ${res.status})${text ? `: ${text}` : ''}`);
  err.status = res.status;
  throw err;
}

/** Text of the first <tag> in an XML string (namespace prefix ignored). */
export const xmlText = (xml, tag) => {
  const m = new RegExp(`<(?:[\\w-]+:)?${tag}[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`, 'i').exec(xml);
  return m ? m[1] : null;
};

/** Every <tag>…</tag> block in an XML string (namespace prefix ignored). */
export const xmlBlocks = (xml, tag) => {
  const re = new RegExp(`<(?:[\\w-]+:)?${tag}[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
};

export const unescapeXml = (s) => String(s ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
