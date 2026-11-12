'use strict';

/**
 * What a workspace without a website answers on its public routes: it is
 * running fine, it just has no site yet. Static HTML on purpose (like the
 * suspended page): there is no web app to render a layout with.
 */

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/** The root answers 200 (nothing is missing there); any other path is a 404. */
export const noWebsiteStatus = (pathname) => (!pathname || pathname === '/' ? 200 : 404);

export function noWebsitePage({ host = '', deskUrl = '/desk' } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="robots" content="noindex">` +
    `<title>No website yet</title></head>` +
    `<body style="display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;` +
    `flex-direction:column;text-align:center;padding:24px;box-sizing:border-box;background:#0b0b0f;` +
    `color:#e5e7eb;font-family:ui-sans-serif,system-ui">` +
    `<h1 style="font-size:32px;margin:0 0 12px">This workspace has no website yet</h1>` +
    `<p style="font-size:16px;margin:0 0 28px;max-width:32rem;opacity:.75">` +
    `${host ? `<strong>${escapeHtml(host)}</strong> is up and running. ` : ''}` +
    `Sign in to its desk to build a site or install a template.</p>` +
    `<a href="${escapeHtml(deskUrl)}" style="display:inline-block;padding:10px 22px;border-radius:8px;` +
    `background:#6d5df6;color:#fff;font-weight:600;text-decoration:none">Go to the desk</a>` +
    `<span style="margin-top:40px;font-size:13px;opacity:.45">Loopar</span></body></html>`;
}
