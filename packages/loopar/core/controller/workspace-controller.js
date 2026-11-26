'use strict'

import { pathToFileURL } from 'node:url';
import { buildId } from "../server/build-info.js";
import AuthController from "../auth/AuthController.js";
import { signWorkspaceToken } from "../auth/workspace-token.js";
import { loopar, fileManager, PermissionManager, sidebarDashboards } from "loopar";
import { shouldServeProduction } from "../server/runtime-mode.js";
import { kioskHeadTags } from "../global/kiosk-manifest.js";
import { activeAnnouncement } from "../global/announcements.js";
import { seoMeta, organizationJsonLd } from "../global/seo.js";
import { requestLanguage, clientI18nPayload, contentLanguages, siteLanguages, siteDefaultLanguage, translateRecord, loadRegional, availableLanguages } from "../server/i18n.js";
import { localizePath, splitLanguagePrefix } from "../global/i18n.js";
import { readDeskPins } from "../document/desk-pins.js";
import fs from 'fs';

/** Builders whose documents are not desk destinations (controllers, print formats). */
const NON_DESK_BUILDERS = new Set(['Controller Builder', 'Print Format Builder']);
const DESK_VIEW_TYPES = new Set(['Desk Page', 'Report', 'View']);
/** Home every app without one of its own opens (`?app=<name>`): not a destination by itself. */
const APP_HOME_PAGE = 'App Home';

/**
 * How a document opens in the desk: 'page' | 'single' | 'list', or null when
 * it isn't a desk destination. Page Builder pages are the website's in apps
 * that have one (`websiteApps`, lowercased names); in the others (Backups,
 * App Manager…) they are desk pages.
 */
function deskKind(ref, websiteApps = new Set()) {
  if (!ref?.__NAME__ || ref.__NAME__ === APP_HOME_PAGE || ref.is_child || NON_DESK_BUILDERS.has(ref.__ENTITY__) || ref.__TYPE__ === 'Controller') return null;
  if (ref.__ENTITY__ === 'Page Builder') return websiteApps.has(String(ref.__APP__).toLowerCase()) ? null : 'page';
  if (ref.__ENTITY__ === 'Desk Page Builder' || DESK_VIEW_TYPES.has(ref.__TYPE__)) return 'page';
  return ref.is_single ? 'single' : 'list';
}

const KIND_ACTION = { page: 'view', single: 'update', list: 'list' };

/**
 * Where a document opens for the viewer (`can(entity, action)`): lists open
 * their list, singles their form, desk pages and reports their view. null
 * when it isn't a desk destination or the viewer can't open it.
 */
function deskDestination(ref, can, websiteApps) {
  const kind = deskKind(ref, websiteApps);
  if (!kind || !can(ref.__NAME__, KIND_ACTION[kind])) return null;
  return { name: ref.__NAME__, kind, link: `/desk/${ref.__NAME__}/${KIND_ACTION[kind]}` };
}

const relevanceCache = new WeakMap();

/**
 * Entity centrality per app, from the schema: +1 per connection field pointing
 * at the entity, +1 per connection it holds (child tables included); 0 if unconnected.
 * → { [entity name, lowercased]: score }, cached per refs build.
 */
function entityRelevance(refs) {
  const cached = relevanceCache.get(refs);
  if (cached) return cached;

  const key = (name) => String(name ?? '').toLowerCase();
  const connections = (ref) => Object.values(ref?.__FIELD_META__ || {})
    .filter(m => m.element === 'connection' && m.options && key(m.options) !== key(ref.__NAME__));

  const byName = Object.fromEntries(Object.values(refs).map(ref => [key(ref.__NAME__), ref]));
  const score = {};
  const add = (name, n = 1) => { score[name] = (score[name] || 0) + n; };

  for (const ref of Object.values(refs)) {
    for (const m of connections(ref)) add(key(m.options));
    if (ref.is_child) continue;
    add(key(ref.__NAME__), connections(ref).length);
    for (const m of Object.values(ref.__FIELD_META__ || {})) {
      if (m.element === 'form_table' && m.options) add(key(ref.__NAME__), connections(byName[key(m.options)]).length);
    }
  }

  relevanceCache.set(refs, score);
  return score;
}

/**
 * { [module, lowercased]: destinations } of every document the user reaches,
 * lists first (the most related ones on top), then settings, then pages.
 */
function moduleDestinations(username, websiteApps) {
  const can = (doc, action) => PermissionManager.can(doc, action, username);
  const refs = loopar.getRefs() || {};
  const relevance = entityRelevance(refs);
  const byModule = {};
  for (const ref of Object.values(refs)) {
    const dest = deskDestination(ref, can, websiteApps);
    if (dest) (byModule[String(ref.__MODULE__ ?? '').toLowerCase()] ??= []).push(dest);
  }
  const order = { list: 0, single: 1, page: 2 };
  const rank = (d) => relevance[d.name.toLowerCase()] || 0;
  for (const list of Object.values(byModule)) {
    list.sort((a, b) => order[a.kind] - order[b.kind] || rank(b) - rank(a) || a.name.localeCompare(b.name));
  }
  return byModule;
}

/** Lowercased names of the installed apps that have a website (their pages are web pages). */
async function websiteApps() {
  try {
    const apps = await loopar.db.getAll('App', ['name', 'has_website']);
    return new Set(apps.filter(a => loopar.utils.trueValue(a.has_website)).map(a => String(a.name).toLowerCase()));
  } catch {
    return new Set();
  }
}

/**
 * A sidebar module with what it opens: its documents (`docs`), one section
 * per submodule, and `direct` — the only document it holds, opened straight
 * from the sidebar instead of through the module page.
 */
function withDestinations(module, byModule) {
  const docs = byModule[String(module.link).toLowerCase()] || [];
  const sections = (module.submodules || [])
    .map(name => ({ name, docs: byModule[String(name).toLowerCase()] || [] }))
    .filter(s => s.docs.length);
  const all = [...docs, ...sections.flatMap(s => s.docs)];
  return { ...module, docs, sections, direct: all.length === 1 ? all[0].link : null };
}

export default class WorkspaceController extends AuthController {
  constructor(props) {
    super(props);
    Object.assign(this, props);
  }

  async getWorkspace(workspace = this.workspace) {
    const meta = {};
    meta.action = this.action;

    const WORKSPACE = {
      name: workspace,
      user: loopar.currentUser,
    }

    if (workspace === "desk") {
      const sites = await websiteApps();
      WORKSPACE.menu_data =  await WorkspaceController.sidebarData(undefined, sites);
      // Pages the user pinned to the shortcuts menu (null: never saved, the menu shows its defaults).
      WORKSPACE.desk_pins = await readDeskPins();
      // Base + extra languages of the tenant's websites (translation editors).
      WORKSPACE.content_languages = contentLanguages();
      // Languages with a dictionary: the desk's per-element overrides offer them.
      WORKSPACE.ui_languages = availableLanguages().filter((l) => l !== "en");
      // The designer palette offers app-provided elements of these apps only.
      WORKSPACE.installed_apps = Object.keys(loopar.installedApps || {});
      // Whether this host serves a website: without one the desk offers no link to it.
      WORKSPACE.has_website = !!loopar.webApp?.name;
    } else if (workspace === "web" || workspace === "kiosk") {
      // Kiosk pages are web pages without the site's navigation: same app (logo, theme).
      // Footer, copyright… in the visitor's language (App translatable fields).
      // `translations` stays on the server: the page only needs the shown texts.
      const { translations, ...webApp } = translateRecord("App", loopar.webApp, { parsed: true }) || {};
      WORKSPACE.web_app = loopar.webApp ? webApp : loopar.webApp;
      // Languages the site publishes: internal links keep the visitor's
      // language prefix and the language switcher lists them.
      WORKSPACE.site_languages = WorkspaceController.siteLanguagesMeta(this.req);
      if (workspace === "web") WORKSPACE.announcement = await activeAnnouncement(loopar.webApp?.name);
      // Canonical URL of the page and whether the site hides from search engines.
      if (workspace === "web") WORKSPACE.seo = seoMeta(this.req);
    } else if (workspace === "portal") {
      // The portal is the signed-in side of the site: it wears the host's web app (logo, theme).
      WORKSPACE.web_app = loopar.webApp;
      WORKSPACE.menu_data = await WorkspaceController.portalMenuData(loopar.auth.user());
    }

    return {
      key: this.getKey(),
      ...WORKSPACE,
      Document: {
        meta: {
          action: this.action
        },
        data: this.__DATA__
      }
    }
  }

  /**
   * The site's languages for the page: default, published list, and the
   * alternate URL of the current page in each one (hreflang). The page path
   * is the request url without its language prefix (stripped by the router).
   */
  static siteLanguagesMeta(req) {
    const def = siteDefaultLanguage();
    const languages = siteLanguages();
    const site = { default: def, languages };
    if (languages.length < 2 || !req) return { ...site, alternates: [] };

    const proto = req.protocol || "https";
    const origin = `${proto}://${req.get?.("host") || req.headers?.host || ""}`;
    const path = splitLanguagePrefix((req.originalUrl || "/").split("?")[0], languages).path;
    const alternates = languages.map((code) => ({ language: code, href: origin + localizePath(path, code, site) }));
    alternates.push({ language: "x-default", href: origin + localizePath(path, def, site) });
    return { ...site, alternates };
  }

  hasPermission(document, action){
    return true
  }

  async render(__META__, checkAuth = false) {
    if (checkAuth) {
      ///await this.beforeAction();
    }
    
    global.File = class SimulatedFile {
      constructor(buffer, fileName, options = {}) {
        this.buffer = Buffer.from(buffer);
        this.name = fileName || options.filename || 'untitled.txt';
        this.size = this.buffer.length;
        this.type = options.contentType || 'application/octet-stream';
      }
    }

    const url = this.req.originalUrl;
    const isProduction = shouldServeProduction();
    let HTML;

    const _p = (path) => loopar.makePath(loopar.pathRoot, path);
    const vite = loopar.server.vite

    const [{ render }, template] = await Promise.all([
      isProduction
        ? import(pathToFileURL(_p("dist/server/entry-server.js")).href)
        : vite.ssrLoadModule(_p("app/entry-server.jsx")),
      isProduction
        ? fs.readFileSync("dist/client/main.html", "utf-8")
        : vite.transformIndexHtml(
            url,
            fs.readFileSync(_p("main.html"), "utf-8")
          ),
    ]);
        const userData = await loopar.auth.award(false);
    const username = userData?.name || "Guest";

    const permissions = PermissionManager.getPermissions(username);

    const avatarUrl = (() => {
      const raw = userData?.profile_picture;
      if (typeof raw === "string" && /^https?:\/\//i.test(raw.trim())) {
        return raw.trim();
      }
      const f = loopar.utils.JSONparse(raw, null);
      const first = Array.isArray(f) ? f[0] : f;
      return (first && typeof first === "object" ? first.src : first) || null;
    })();

    __META__.user = userData ? {
      userId: userData.name,
      name: userData.name,
      email: userData.email,
      profilePicture: avatarUrl,
      user_type: userData.user_type
    } : null;
    __META__.userId = userData?.name;
    __META__.site = loopar.tenantId;
    // Language the page renders in (URL prefix on sites, user/system on the
    // desk). The browser gets the same language and dictionary before
    // hydration (see __LOOPAR_I18N__ below), so SSR and client text match.
    const language = requestLanguage();
    __META__.language = language;
    await loadRegional();
    // Client bundle this page boots with; compared against X-Loopar-Build on
    // every later response to detect a newer deploy (null in development).
    __META__.build = buildId();

    HTML = await render(url, __META__, this.req, this.res, permissions);

    __META__.csrfToken = userData?.csrfToken ?? null;
    // Signed workspace identity (see core/auth/workspace-token.js). The
    // workspace of a real navigation IS trustworthy (it came from the URL of
    // this GET) — sign it so the client can prove its browsing context on
    // every subsequent RPC via the X-Workspace-Token header.
    __META__.wsToken = signWorkspaceToken(__META__.name || this.workspace) ?? null;
    __META__.permissions = permissions
    
    // The SSR render leaves hoistables (<title>/<meta>/<link>, e.g. from SEO)
    // at the start of the fragment, but hydrateRoot expects them in <head> —
    // inline they desync the whole tree. Move them to the template's <head>.
    
    let fragment = HTML.HTML || "";
    let hoisted = "";
    const HOIST_RE = /^\s*(<title>[\s\S]*?<\/title>|<meta\s[^>]*\/?>|<link\s[^>]*\/?>)/;
    for (let m; (m = fragment.match(HOIST_RE)); ) {
      hoisted += m[1];
      fragment = fragment.slice(m[0].length);
    }

    let html = template.replace(`<!--ssr-outlet-->`, fragment);
    if (hoisted) html = html.replace("</head>", `${hoisted}</head>`);

    // The company's structured data (schema.org), on public pages of its site.
    if ((__META__.name || this.workspace) === "web") {
      const jsonLd = await organizationJsonLd(this.req).catch(() => null);
      if (jsonLd) {
        const json = JSON.stringify(jsonLd).replace(/</g, "\\u003c");
        html = html.replace("</head>", `<script type="application/ld+json">${json}</script></head>`);
      }
    }
    const cookieTheme = loopar.cookie.get('vite-ui-theme');
    const ssrTheme =
      cookieTheme === 'light' || cookieTheme === 'dark' ? cookieTheme : 'dark';
    html = html.replace('${THEME}', ssrTheme);

    const faviconSrc = fileManager.getMappedFiles(__META__.web_app?.favicon)[0]?.src;

    const kioskTags = (__META__.name || this.workspace) === "kiosk" ? kioskHeadTags(__META__.Document?.Entity?.name) : "";
    html = html.replace(`<!--__favicon__-->`, `<link rel="icon" href="${faviconSrc || "/assets/public/loopar-favicon.ico"}"/>${kioskTags}`)

    let themeVersion = '0';
    try { themeVersion = Math.floor(fs.statSync(loopar.themeCssPath()).mtimeMs).toString(36); } catch {}
    html = html.replace(`<!--__theme-definition__-->`, `
      <link rel="stylesheet" href="/assets/public/theme.css?v=${themeVersion}"/>
    `)

    html = html.replace(/<html([^>]*?)\slang="[^"]*"/, `<html$1 lang="${language}"`);

    // `<` escaped so a translation can never close the script element.
    const i18nJson = JSON.stringify(clientI18nPayload(language)).replace(/</g, "\\u003c");
    html = html.replace(`<!--__loopar-meta-data__-->`, `
      <script>window.__LOOPAR_I18N__ = ${i18nJson};</script>
      <script id="__loopar-meta-data__" type="application/json">
        ${JSON.stringify(__META__)}
      </script>
    `);

    html = html.replace(`<!--__loopar-env__-->`, `
      <script>
        window.process = ${JSON.stringify({
          env: {
            // The tenant identity the client needs is __META__.site (set above);
            // process.env.TENANT_ID no longer exists in the tenant-less core, so
            // injecting it produced `undefined`. Expose the resolved tenant name
            // here too for any legacy reader, plus NODE_ENV for error-boundary.
            TENANT_ID: loopar.tenantId,
            NODE_ENV: isProduction ? 'production' : 'development',
          }
        })};
      </script>
    `);

    return {
      status: 200,
      body: html,
      headers: { 'Content-Type': 'text/html' }
    }
  }

  getKey(route = this.dictUrl) {
    const query = route.search ? route.search.split('?') : '';
    route.query = query[1] || '';

    const key = route.query.split('&').map(q => q.split('=')).filter(q => q[0] === 'name').join();

    return loopar.utils.hash(`${route.pathname}${key}`.toLowerCase());
  }

  /**
   * Desk menu for the current user: apps (rail) → home + modules. Only
   * modules the user can reach (derived from document permissions, see
   * PermissionManager.canAccessModule), the home only if the user may open
   * it, and only apps with at least one such module. Administrator sees all.
   */
  /** The desk's menu and search index, fresh: for a desk that must redraw its sidebar (apps installed/removed). */
  /** The current user's command palette / shortcuts index. The desk asks for it after loading (see search-index.js). */
  static async searchIndex() {
    return WorkspaceController.deskSearchIndex(undefined, await websiteApps());
  }

  static async deskMenu() {
    const sites = await websiteApps();
    return {
      menu_data: await WorkspaceController.sidebarData(undefined, sites),
      search_index: WorkspaceController.deskSearchIndex(undefined, sites),
    };
  }

  static async sidebarData(username = loopar.auth.user(), sites = null) {
    const all = loopar.deskMenu || [];
    // Dashboards are records (not part of the built menu): read per request.
    const dashboards = await sidebarDashboards(username);
    const byModule = moduleDestinations(username, sites ?? await websiteApps());
    const isAdmin = username === 'Administrator';

    const apps = [];
    for (const app of all) {
      const modules = (app.modules || [])
        .filter(m => isAdmin || PermissionManager.canAccessModule(m.link, username))
        .map(m => withDestinations(m, byModule));
      const home = app.home && (isAdmin || PermissionManager.can(app.home, 'view', username)) ? app.home : null;
      if (modules.length) apps.push({ ...app, home, modules, dashboards: dashboards[app.name] || [] });
    }
    return apps;
  }

  /**
   * Entries of the desk command palette (Ctrl/Cmd+K) for the current user:
   * every entity of the installed apps the user may reach, with the route it
   * opens. Lists get "list" + "new", singles open their form, desk pages and
   * reports their view. Web pages, controllers, print formats and child
   * tables are not desk destinations.
   */
  static deskSearchIndex(username = loopar.auth.user(), sites = new Set()) {
    const can = (doc, action) => PermissionManager.can(doc, action, username);

    const items = [];
    for (const ref of Object.values(loopar.getRefs() || {})) {
      const base = { entity: ref.__NAME__, app: ref.__APP__ };
      const dest = deskDestination(ref, can, sites);
      if (dest) items.push({ ...base, kind: dest.kind, link: dest.link });
      if (deskKind(ref, sites) === 'list' && can(ref.__NAME__, 'create')) {
        items.push({ ...base, kind: 'new', link: `/desk/${ref.__NAME__}/create` });
      }
    }

    return items;
  }

  static async portalMenuData(username) {
    username = username || loopar.auth.user();
    // Grants of the user only: public actions (a blog's public view) are the
    // website's business, not entries of the user's portal.
    const can = (doc, action) => PermissionManager.scope(doc, action, username, { includePublic: false }) !== null;

    const groups = [];
    for (const app of (loopar.deskMenu || [])) {
      const routes = [];
      for (const m of (app.modules || [])) {
        for (const r of (m.routes || [])) {
          const entity = r.description;
          const action = r.link === 'update' ? 'update' : 'list';
          if (can(entity, action) || can(entity, 'view')) {
            routes.push({ label: entity, icon: m.icon, link: `/portal/${entity}/${action}` });
          }
        }
      }
      if (routes.length) groups.push({ name: app.description, routes });
    }

    return {
      groups,
      // `/portal` opens the portal home page (apps/loopar web module) when installed.
      home: loopar.getRef('Portal Home', false) ? { label: 'Home', link: '/portal' } : null,
      profile: { label: 'Profile', link: '/portal/Profile/update' },
    };
  }
}