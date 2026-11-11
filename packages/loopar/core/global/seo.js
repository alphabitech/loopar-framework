'use strict';

/*
 * Search-engine plumbing of a website (the request's web app): the canonical
 * URL of each page, robots.txt, sitemap.xml and the company's structured
 * data. Everything is derived from what the site already declares — its menu,
 * its published collection records and the tenant's Company — so a site is
 * indexable without configuring anything.
 */

import { loopar, fileManager } from 'loopar';
import { getCompany } from './company.js';
import { localizePath, splitLanguagePrefix } from './i18n.js';
import { siteLanguages, siteDefaultLanguage } from '../server/i18n.js';
import { VALID_WORKSPACES } from './router-utils.js';

const COLLECTION_ELEMENTS = ['collection', 'collection_view'];
const TRUE = [1, '1', true, 'true'];

const key = (v) => loopar.utils.toEntityKey(v);

/** URL segment of a menu link: "About Us" → "about-us" (same as the site's navigation). */
export const menuPath = (link) => encodeURIComponent(String(link ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-'));

const escapeXml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const hostOf = (req) => String(req?.get?.('host') || req?.headers?.host || '').toLowerCase();
const bareHost = (host) => String(host || '').toLowerCase().replace(/:\d+$/, '').replace(/^www\./, '');

/** `https://example.com` of the request. */
export function siteOrigin(req) {
  return `${req?.protocol || 'https'}://${hostOf(req)}`;
}

const siteOf = (webApp = loopar.webApp) => ({ default: siteDefaultLanguage(webApp), languages: siteLanguages(webApp) });

/**
 * True when the site must stay out of search engines: its App says so
 * ("Hide from search engines", e.g. a staging copy) or it runs on a local host.
 */
export function isNoindex(req, webApp = loopar.webApp) {
  if (TRUE.includes(webApp?.noindex)) return true;
  const host = bareHost(hostOf(req));
  return host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1';
}

/**
 * The menu item whose link is the public URL of `item`'s page: the first one
 * shown in the navigation. Hidden (`router_only`) links to the same page are
 * aliases of it (`/services` of a page published as `/solutions`).
 */
function preferredItem(item, items) {
  if (!item || !TRUE.includes(item.router_only)) return item;
  return items.find((i) => !TRUE.includes(i.router_only) && !i.parent_menu && key(i.page) === key(item.page)) || item;
}

/** Path of a top-level menu item; the first item of the menu is the home page. */
const itemPath = (item, items) => (item === items[0] ? '/' : `/${menuPath(item.link)}`);

/**
 * Canonical path of a website path (no language prefix, no query): the page's
 * public link instead of an alias, `/` for the home page, no trailing slash.
 */
export function canonicalPath(pathname, webApp = loopar.webApp) {
  const items = webApp?.menu_items || [];
  const segments = String(pathname || '/').split('?')[0].split('#')[0].split('/').filter(Boolean);
  if (!segments.length) return '/';

  const [first, ...rest] = segments;
  const item = items.find((i) => key(i.link) === key(first));
  if (!item) return `/${segments.join('/')}`;

  const preferred = preferredItem(item, items);
  if (!rest.length) return itemPath(preferred, items);
  return `/${menuPath(preferred.link)}/${rest.join('/')}`;
}

/** Absolute canonical URL of the current request, in the language it was asked in. */
export function canonicalUrl(req, webApp = loopar.webApp) {
  if (!req || !webApp?.name) return null;
  const site = siteOf(webApp);
  const { language, path } = splitLanguagePrefix((req.originalUrl || '/').split('?')[0], site.languages);
  return siteOrigin(req) + localizePath(canonicalPath(path, webApp), language || site.default, site);
}

/** What the page's <head> needs: `{ canonical, noindex }`. */
export function seoMeta(req, webApp = loopar.webApp) {
  return { canonical: canonicalUrl(req, webApp), noindex: isNoindex(req, webApp) };
}

/** Link of the root ancestor of a nested menu item (its URL is `/root/item`). */
function rootLink(item, items) {
  let parent = null;
  let parentLink = item.parent_menu;
  for (let depth = 0; parentLink && depth < 20; depth++) {
    const found = items.find((i) => key(i.link) === key(parentLink));
    if (!found) break;
    parent = found;
    parentLink = found.parent_menu;
  }
  return parent?.link || null;
}

/** Entities listed by the collection elements of a page. */
async function collectionEntities(page) {
  const ref = loopar.getRef(page);
  if (!ref) return [];
  let structure = null;
  try {
    structure = await loopar.db.getValue(ref.__ENTITY__, 'doc_structure', ref.__NAME__, { ifNotFound: null });
  } catch {
    return [];
  }
  const elements = loopar.utils.fieldList(loopar.utils.JSONparse(structure, []) || []);
  return [...new Set(elements
    .filter((el) => COLLECTION_ELEMENTS.includes(el?.element) && el.data?.options)
    .map((el) => String(el.data.options).trim()))];
}

/** Published records of a collection entity that have a detail page on this site. */
async function publishedRecords(entity, app) {
  const ref = loopar.getRef(entity);
  if (!ref) return [];
  const has = (name) => (ref.__FIELDS__ || []).some((f) => (f?.data?.name ?? f) === name);
  if (!has('slug') || !has('published')) return [];
  try {
    const filter = { published: 1 };
    if (app && has('app')) filter.app = app;
    return await loopar.db.qx()(entity).select('*').where(filter).whereNull('__deleted_at__').whereNotNull('slug');
  } catch (e) {
    console.warn(`[seo] sitemap: ${entity} unavailable:`, e?.message);
    return [];
  }
}

const isoDate = (value) => {
  const d = value ? new Date(value) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : null;
};

/**
 * `[{ path, lastmod }]` of the site: the pages of its navigation plus the
 * detail page of every published collection record (`/solutions/<slug>`).
 */
export async function sitemapEntries(webApp = loopar.webApp) {
  const items = webApp?.menu_items || [];
  const entries = new Map();
  const add = (path, lastmod = null) => { if (!entries.has(path)) entries.set(path, { path, lastmod }); };

  for (const item of items) {
    if (TRUE.includes(item.router_only) || !item.link) continue;
    if (item.parent_menu) {
      const root = rootLink(item, items);
      add(root ? `/${menuPath(root)}/${menuPath(item.link)}` : `/${menuPath(item.link)}`);
    } else {
      add(itemPath(item, items));
    }
  }

  // Detail pages hang from the page's public link, also for pages reachable
  // only by link (e.g. `/legal/<slug>`).
  const bases = new Map();
  for (const item of items) {
    if (item.parent_menu || !item.page) continue;
    const preferred = preferredItem(item, items);
    if (!bases.has(key(preferred.page))) bases.set(key(preferred.page), preferred);
  }
  for (const item of bases.values()) {
    for (const entity of await collectionEntities(item.page)) {
      for (const row of await publishedRecords(entity, webApp?.name)) {
        add(`/${menuPath(item.link)}/${encodeURIComponent(String(row.slug).trim())}`, isoDate(row.__updated_at__));
      }
    }
  }

  return [...entries.values()];
}

/** sitemap.xml of the request's site: every entry in every language it publishes. */
export async function sitemapXml(req, webApp = loopar.webApp) {
  const origin = siteOrigin(req);
  const site = siteOf(webApp);
  const entries = isNoindex(req, webApp) ? [] : await sitemapEntries(webApp);

  const urls = entries.flatMap(({ path, lastmod }) => site.languages.map((language) => [
    '  <url>',
    `    <loc>${escapeXml(origin + localizePath(path, language, site))}</loc>`,
    lastmod ? `    <lastmod>${lastmod}</lastmod>` : null,
    '  </url>',
  ].filter(Boolean).join('\n')));

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    '</urlset>',
    '',
  ].join('\n');
}

/** robots.txt of the request's site: everything public except the workspaces, plus the sitemap. */
export function robotsTxt(req, webApp = loopar.webApp) {
  if (isNoindex(req, webApp)) return 'User-agent: *\nDisallow: /\n';
  return [
    'User-agent: *',
    ...VALID_WORKSPACES.map((workspace) => `Disallow: /${workspace}/`),
    '',
    `Sitemap: ${siteOrigin(req)}/sitemap.xml`,
    '',
  ].join('\n');
}

const absoluteUrl = (src, origin) => (!src ? null : /^https?:\/\//i.test(src) ? src : origin + (src.startsWith('/') ? src : `/${src}`));

/**
 * schema.org Organization of the tenant's Company for this site, or null.
 * A tenant serving several sites describes the company only on the site the
 * Company names as its website.
 */
export async function organizationJsonLd(req, webApp = loopar.webApp) {
  if (!webApp?.name || isNoindex(req, webApp)) return null;
  const company = await getCompany();
  if (!company?.company_name) return null;

  const website = String(company.website || '').trim();
  let websiteHost = null;
  try { websiteHost = website ? bareHost(new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`).host) : null; } catch { /* not a URL */ }
  const ownSite = websiteHost
    ? websiteHost === bareHost(hostOf(req))
    : Object.keys(loopar.webApps || {}).length <= 1;
  if (!ownSite) return null;

  const origin = siteOrigin(req);
  const logo = fileManager.getMappedFiles(company.logo)[0]?.src || fileManager.getMappedFiles(webApp.logo)[0]?.src;
  const address = {
    streetAddress: String(company.address || '').trim().replace(/\s*\n\s*/g, ', ') || undefined,
    addressLocality: company.city || undefined,
    addressRegion: company.state || undefined,
    postalCode: company.postal_code || undefined,
    addressCountry: company.country || undefined,
  };
  const hasAddress = Object.values(address).some(Boolean);

  const data = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: company.company_name,
    legalName: company.legal_name || undefined,
    url: origin,
    logo: absoluteUrl(logo, origin) || undefined,
    email: company.email || undefined,
    telephone: company.phone || undefined,
    address: hasAddress ? { '@type': 'PostalAddress', ...address } : undefined,
  };
  return JSON.parse(JSON.stringify(data));
}
