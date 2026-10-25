'use strict'

import { loopar, fileManage, BaseController, PermissionManager } from "loopar";

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

  redirect(route = '/auth/login', opts = {}) {
    return super.redirect(route, { hard: true, ...opts });
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

  async publicActionConnect() {
    const model = await loopar.newDocument("Connector", this.data);

    if (this.hasData()) {
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
    if (this.hasData()) {
      // When INSTALL_TOKEN is set in the tenant env (cloud-provisioned
      // tenants), the install endpoint demands a matching `X-Install-Token`
      // header before the first install. Tenants created by hand on a
      // private network don't set the token and keep the legacy public
      // behaviour — backward compatible.
      //
      // Once the system is installed (`loopar.__installed__`), the legacy
      // "already installed / role check" guard inside unInstallApp takes
      // over, so the token becomes inert and we don't gate again here.
      const expectedToken = loopar.installToken || '';
      if (expectedToken && !loopar.__installed__) {
        const provided = this.req?.headers?.['x-install-token'] || '';
        if (provided !== expectedToken) {
          return { status: 401, success: false, message: 'Install token required' };
        }
      }
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
      return this.redirect();
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