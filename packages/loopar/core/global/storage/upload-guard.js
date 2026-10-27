'use strict';

import dns from 'node:dns/promises';
import net from 'node:net';

/**
 * Upload / remote-import safety guards, shared by every storage driver.
 *
 * Two independent risks are covered:
 *   1. Stored XSS — a file whose content the browser executes in OUR origin
 *      when it is served inline (SVG with <script>, HTML, XML, JS…). These
 *      extensions / mime types are rejected outright, whatever the upload
 *      channel (public form, desk file manager, server-side import).
 *   2. SSRF — a remote-import URL the server fetches. Only http(s) is allowed
 *      and the resolved host must not be loopback, private, link-local or a
 *      cloud metadata address.
 */

// Content the browser runs when it renders the file inline, in our origin.
const BLOCKED_EXTENSIONS = new Set([
  'html', 'htm', 'xhtml', 'xht', 'shtml', 'shtm', 'htc', 'mhtml', 'mht',
  'svg', 'svgz', 'xml', 'xsl', 'xslt',
  'js', 'mjs', 'cjs', 'jse', 'swf',
]);

const BLOCKED_MIME = new Set([
  'text/html', 'application/xhtml+xml', 'image/svg+xml',
  'text/xml', 'application/xml',
  'application/javascript', 'text/javascript', 'application/x-javascript',
  'application/xhtml',
]);

const extensionOf = (name = '') => {
  const dot = String(name).lastIndexOf('.');
  return dot >= 0 ? String(name).slice(dot + 1).toLowerCase().trim() : '';
};

/**
 * Throws when a filename / mime type is active content that would execute in
 * our origin if served inline. Call it in every driver's `upload()` and on
 * the result of a remote import before storing it.
 */
export function assertSafeUpload(name, mimetype) {
  const ext = extensionOf(name);
  if (ext && BLOCKED_EXTENSIONS.has(ext)) {
    const err = new Error(`File type ".${ext}" is not allowed for security reasons.`);
    err.status = 400;
    err.expose = true;
    throw err;
  }
  const mime = String(mimetype || '').split(';')[0].trim().toLowerCase();
  if (mime && BLOCKED_MIME.has(mime)) {
    const err = new Error(`File content type "${mime}" is not allowed for security reasons.`);
    err.status = 400;
    err.expose = true;
    throw err;
  }
}

export const isPrivateIp = (ip) => {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10) return true;
    if (a === 127) return true;                 // loopback
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;     // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  if (net.isIPv6(ip)) {
    const low = ip.toLowerCase();
    if (low === '::1' || low === '::') return true;     // loopback / unspecified
    if (low.startsWith('fc') || low.startsWith('fd')) return true; // ULA
    if (low.startsWith('fe80')) return true;            // link-local
    if (low.startsWith('::ffff:')) return isPrivateIp(low.slice(7)); // mapped v4
    return false;
  }
  return false;
};

/**
 * Throws when a remote-import URL is unsafe to fetch: wrong scheme, or a host
 * that resolves to a loopback / private / link-local / metadata address
 * (SSRF). Resolves DNS so a public name pointing at 127.0.0.1 is caught too.
 */
export async function assertSafeRemoteUrl(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    const err = new Error('Invalid import URL.');
    err.status = 400; err.expose = true;
    throw err;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    const err = new Error(`URL scheme "${url.protocol}" is not allowed.`);
    err.status = 400; err.expose = true;
    throw err;
  }

  const host = url.hostname.replace(/^\[|\]$/g, '');

  const addrs = net.isIP(host)
    ? [host]
    : (await dns.lookup(host, { all: true })).map((a) => a.address);

  if (!addrs.length || addrs.some(isPrivateIp)) {
    const err = new Error('Import URL resolves to a disallowed address.');
    err.status = 400; err.expose = true;
    throw err;
  }
}
