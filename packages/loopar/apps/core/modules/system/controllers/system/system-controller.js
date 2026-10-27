'use strict'

import crypto from "node:crypto";
import { loopar, fileManage, BaseController, PermissionManager } from "loopar";
import { safeReturnPath } from "../../../../../../core/global/router-utils.js";
import { isPrivateIp } from "../../../../../../core/global/storage/upload-guard.js";

/**
 * Setup actions. They are `publicAction*` so the bootstrap pages (connect /
 * install / update) work before any user exists. Once the system is
 * installed they are revoked (see `revokedPublicActions`) — for System and
 * every subclass (App Manager).
 */
const SETUP_ACTIONS = ['connect', 'install', 'update'];

/** App folder names only: no path separators, no `..`. */
const APP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export default class SystemController extends BaseController {
  client = "form";
  entry = "installer";
  static publicActions = ['connect', 'install', 'update', 'reinstall'];

  constructor(props) {
    super(props);
  }

  // Default landing after a setup action. It used to be always /auth/login:
  // for a user who is already logged in (the usual case after an update)
  // the login page bounces to /desk — the "update → lands on Desk" redirect.
  redirect(route = loopar.auth.user() ? '/desk' : '/auth/login', opts = {}) {
    return super.redirect(route, { hard: true, ...opts });
  }

  /**
   * `?redirect=` forwarded by the update page (set by the system middleware
   * when it detoured the user there). undefined → the controller's default
   * landing (System: desk/login; App Manager: its own view).
   */
  postSetupDestination() {
    const back = safeReturnPath(this.query?.redirect);
    if (!back) return undefined;
    return loopar.auth.user() ? back : `/auth/login?redirect=${encodeURIComponent(back)}`;
  }

  /**
   * Before installation the setup actions are public (the installer has no
   * user yet; INSTALL_TOKEN still gates the first install). After it they
   * used to stay reachable by ANYONE over RPC — `POST /System/connect`
   * rewrote db.config, `/System/update` reinstalled the framework,
   * `/System/install` installed any app: the "spent page" redirect only
   * covers GET pages and `isSystemRpc` lets System RPCs through the system
   * middleware. Revoked once installed:
   *   - connect → no `actionConnect` exists → 404, like any missing action.
   *   - install / update → `actionInstall` / `actionUpdate` below: normal
   *     auth + CSRF, plus an explicit install-manager check.
   */
  revokedPublicActions() {
    const base = super.revokedPublicActions();
    return loopar.__installed__ ? [...base, ...SETUP_ACTIONS] : base;
  }

  async actionInstall() {
    await this.#assertCanManageInstalls();
    return await this.publicActionInstall();
  }

  async actionUpdate() {
    await this.#assertCanManageInstalls();
    return await this.publicActionUpdate();
  }

  async #assertCanManageInstalls() {
    // Mutations only — validateCsrf exempts GET, and `update` needs no body.
    const method = String(this.method || '').toUpperCase();
    if (method === 'GET' || method === 'HEAD') {
      loopar.throw({ code: 404, message: `The action action${loopar.utils.Capitalize(this.action)} not found.` });
    }

    // PermissionManager grants every `publicAction*` to everyone (System:install
    // is in its public set), so can(doc, 'install') is always true. Gate on the
    // non-public `reinstall` permission — same capability: manage app installs.
    const user = loopar.auth.user();
    if (user !== 'Administrator' && !PermissionManager.can(this.document, 'reinstall', user)) {
      loopar.throw({ code: 403, message: 'You do not have permission to perform this action' });
    }
  }

  #safeAppName(name) {
    const appName = String(name ?? '').trim();
    if (!APP_NAME_RE.test(appName)) {
      loopar.throw({ code: 400, title: 'Bad Request', message: `Invalid app name "${appName}".` });
    }
    return appName;
  }

  // ---- Pre-install setup gate ------------------------------------------------
  // Before a tenant is installed, `connect`/`install` are public so the setup
  // wizard works with no user yet. That left a fresh tenant reachable over a
  // public IP open to takeover by whoever POSTed first. The gate below closes
  // it WITHOUT touching the browser wizard:
  //   - local / LAN origin  -> allowed, no token (dev + same-network installs).
  //   - remote (public IP)  -> a valid install token is required. The token
  //     rides in the install link the CLI/TUI prints; opening that link drops
  //     a short-lived setup cookie, so the wizard's own POSTs carry it with no
  //     hand-typing. After install the actions are revoked and it goes inert.

  #setupCookieName() {
    return `loopar_setup_${loopar.tenantId || 'default'}`;
  }

  #clientIp() {
    return this.req?.ip
      || this.req?.socket?.remoteAddress
      || '';
  }

  #isLocalRequest() {
    return isPrivateIp(String(this.#clientIp()).replace(/^::ffff:/, ''));
  }

  #tokensMatch(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    try { return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); }
    catch { return false; }
  }

  #providedSetupToken() {
    return (
      this.req?.headers?.['x-install-token'] ||
      this.query?.install_token ||
      loopar.cookie.get(this.#setupCookieName()) ||
      ''
    );
  }

  #hasValidSetupToken() {
    const expected = loopar.installToken || '';
    return !!expected && this.#tokensMatch(String(this.#providedSetupToken()), expected);
  }

  /** On a setup GET carrying a valid `?install_token`, remember it in a cookie. */
  #captureSetupToken() {
    if (loopar.__installed__) return;
    const token = this.query?.install_token;
    const expected = loopar.installToken || '';
    if (token && expected && this.#tokensMatch(String(token), expected)) {
      loopar.cookie.set(this.#setupCookieName(), expected, {
        httpOnly: true,
        path: '/',
        maxAge: 30 * 60 * 1000, // 30 min: long enough to finish the wizard
      });
    }
  }

  #assertSetupOrigin() {
    if (loopar.__installed__) return;
    if (this.#isLocalRequest()) return;
    if (this.#hasValidSetupToken()) return;
    loopar.throw({
      code: 403,
      title: 'Forbidden',
      message: 'This workspace can only be set up from its own machine or with a valid install link.',
    });
  }

  async publicActionConnect() {
    this.#captureSetupToken();
    const model = await loopar.newDocument("Connector", this.data);

    if (this.hasData()) {
      this.#assertSetupOrigin();
      if (await model.connect()) {
        return this.redirect('/desk');
      }
    } else {
      const response = await model.__meta__();
      
      response.data = {
        dialect: "mysql",
        host: "localhost",
        port: "3306",
        user: "root",
        password: "root",
        time_zone: "+00:00",
      }

      return await this.render(response);
    }
  }

  getAppName() {
    return this.#safeAppName(this.query.app_name || "loopar");
  }

  async getInstallerModel(appName, data = {}) {
    appName = this.#safeAppName(appName || this.getAppName());
    const installerRoute = loopar.makePath('apps', appName, 'installer.js')

    const Installer = await fileManage.importClass(installerRoute, false);

    if (Installer) return new Installer(this.data);
    return await loopar.newDocument("Installer", { ...(data || this.data), app_name: appName || this.app_name });
  }

  async unInstallApp(appName, data = {}, reinstall = false) {
    const model = await this.getInstallerModel(appName, data);
    model.app_name ??= appName || this.getAppName();
    
    if (loopar.__installed__ && await loopar.appStatus(model.app_name) === 'installed' && !reinstall) {
      loopar.throw({ status: 409, title: 'Conflict', message: 'App already installed, please refresh the page' });
    }

    await model.install(reinstall);
  }

  async publicActionInstall(reinstall = false) {
    this.#captureSetupToken();
    if (this.hasData()) {
      // Pre-install, remote clients need the install token; local/LAN don't.
      // Once installed, unInstallApp's "already installed / role" guard takes
      // over and this is inert.
      this.#assertSetupOrigin();
      await this.unInstallApp(this.getAppName(), this.data, reinstall);
      return this.redirect("view");
    } else {
      const model = await loopar.newDocument("Installer", this.data)
      const response = await model.__meta__();

      return await this.render(response);
    }
  }

  async publicActionUpdate() {
    const appName = this.getAppName();
    if (appName) {
      const model = await this.getInstallerModel();
      model.app_name ??= this.getAppName();

      await model.install(true);
      return this.redirect(this.postSetupDestination());
    } else {
      const model = await loopar.newDocument("Update", this.data)
      const response = await model.__meta__();

      return await this.render(response);
    }
  }

  async actionReinstall() {
    return await this.publicActionInstall(true);
  }

  async actionUninstall() {
    const app = await loopar.getDocument("App", this.data.app_name);
    await app.unInstall();
    return this.refresh('view');  
  }
}