'use strict'

import { pathToFileURL } from 'node:url';
import AuthController from "../auth/AuthController.js";
import { signWorkspaceToken } from "../auth/workspace-token.js";
import { loopar, fileManager, PermissionManager } from "loopar";
import { shouldServeProduction } from "../server/runtime-mode.js";
import fs from 'fs';

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
      WORKSPACE.menu_data =  await WorkspaceController.sidebarData();
    } else if (workspace === "web") {
      WORKSPACE.web_app = loopar.webApp;
    } else if (workspace === "portal") {
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

    HTML = await render(url, __META__, this.req, this.res, permissions);

    __META__.csrfToken = userData?.csrfToken ?? null;
    // Signed workspace identity (see core/auth/workspace-token.js). The
    // workspace of a real navigation IS trustworthy (it came from the URL of
    // this GET) — sign it so the client can prove its browsing context on
    // every subsequent RPC via the X-Workspace-Token header.
    __META__.wsToken = signWorkspaceToken(__META__.name || this.workspace) ?? null;
    __META__.permissions = permissions
    
    // renderToString leaves hoistables (<title>/<meta>/<link>, e.g. from SEO)
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
    const cookieTheme = loopar.cookie.get('vite-ui-theme');
    const ssrTheme =
      cookieTheme === 'light' || cookieTheme === 'dark' ? cookieTheme : 'dark';
    html = html.replace('${THEME}', ssrTheme);

    const faviconSrc = fileManager.getMappedFiles(__META__.web_app?.favicon)[0]?.src;

    html = html.replace(`<!--__favicon__-->`, `<link rel="icon" href="${faviconSrc || "/assets/public/loopar-favicon.ico"}"/>`)

    let themeVersion = '0';
    try { themeVersion = Math.floor(fs.statSync(loopar.themeCssPath()).mtimeMs).toString(36); } catch {}
    html = html.replace(`<!--__theme-definition__-->`, `
      <link rel="stylesheet" href="/assets/public/theme.css?v=${themeVersion}"/>
    `)

    html = html.replace(`<!--__loopar-meta-data__-->`, `
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
  static async sidebarData(username = loopar.auth.user()) {
    const all = loopar.deskMenu || [];
    if (username === 'Administrator') return all;

    const apps = [];
    for (const app of all) {
      const modules = (app.modules || []).filter(m => PermissionManager.canAccessModule(m.link, username));
      const home = app.home && PermissionManager.can(app.home, 'view', username) ? app.home : null;
      if (modules.length) apps.push({ ...app, home, modules });
    }
    return apps;
  }

  static async portalMenuData(username) {
    username = username || loopar.auth.user();
    const can = (doc, action) => PermissionManager.can(doc, action, username);

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
      profile: { label: 'Profile', link: '/portal/Profile/update' },
    };
  }
}