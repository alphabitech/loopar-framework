import HTTP from '@@tools/router/http';
import { getWorkspaceName } from '@global/router-utils';
import { navTrace } from './nav-trace.js';

export default class Router extends HTTP {
  /**
   * THE method — RPC in the literal sense (Remote Procedure Call): invoke
   * a controller action as if it were a local function.
   *
   * call("User", "update", { body })  →  POST /User/update
   *
   * @param {string} Document - Entity/controller name.
   * @param {string} action - Controller action to execute.
   * @param {Object} [options] - { body, query, success, error, always, freeze }
   * @returns {Promise} Resolves with the controller response (promise mode
   *   when no success/error/always callback is provided).
   */
  call(Document, action, options = {}) {
    const { success, error, always } = options;

    if(!Document) {
      const workspace = this.workspace;
      const url = window.location.pathname;

      Document = url.split('/')[workspace === "web" ? 1 : 2];
    }

    const sendArgs = {
      ...options,
      method: "POST",
      action: `/${Document}/${action}`,
    };

    if (success || error || always) {
      return this.send(sendArgs);
    }

    return new Promise((resolve, reject) => {
      this.send({ ...sendArgs, success: resolve, error: reject });
    });
  }

  /**
   * Real navigation fetch — the ONLY request that names a workspace, and it
   * does so as a parameter (`?workspace=`), never as a URL segment. Used by
   * the workspace provider to ask the server for the meta of whatever was
   * navigated to (the URL posted is the browser's current path).
   *
   * @param {string} path - The navigated pathname (as shown in the browser).
   * @param {Object} [options] - { workspace, query, success, error, always, freeze }
   */
  fetchDocument(path, options = {}) {
    const { workspace, query = {}, ...rest } = options;

    return this.send({
      method: "POST",
      action: path,
      query: { ...query, workspace: workspace || this.workspace },
      ...rest,
    });
  }
  #navigate = null;
  #workspace = null;
  #user = null;

  /** Injected by <RouterBridge/> when mounted. */
  _bindRouter({ navigate }) {
    this.#navigate = navigate;
  }

  _unbindRouter() {
    this.#navigate = null;
  }

  /** Injected by <WorkspaceProvider/> — the active workspace name. */
  _bindWorkspace(workspace) {
    this.#workspace = workspace || null;
  }

  /** Injected by <WorkspaceProvider/> — the reactive session user. */
  _bindSession(user) {
    this.#user = user || null;
  }

  /**
   * Active workspace name. Prefers the provider-bound value; falls back to
   * the URL (client) or "web" (SSR) before the provider mounts.
   */
  get workspace() {
    if (this.#workspace) return this.#workspace;
    if (typeof window === "undefined") return "web";
    return getWorkspaceName(window.location.pathname);
  }

  /**
   * Navigates to a route using react-router.
   * @param {string} to - Absolute or relative path to the active workspace.
   * @param {{ replace?: boolean, state?: any }} [options]
   */
  navigate(to, options = {}) {
    const target = this.#resolveUrl(to);
    navTrace('navigate', { to: target, ...(target !== to ? { requested: to } : {}), router: !!this.#navigate });

    if (this.#navigate) {
      this.#navigate(target, options);
      return;
    }

    if (typeof window !== 'undefined') {
      window.location.assign(target);
    }
  }

  #resolveUrl(route) {
    if (typeof route !== 'string') return route;

    if (!route.startsWith('/')) {
      if (typeof window === 'undefined') return route;
      const currentPath = window.location.pathname;
      const lastSlash = currentPath.lastIndexOf('/');
      const parent = lastSlash >= 0 ? currentPath.slice(0, lastSlash + 1) : '/';
      return parent + route;
    }

    const isLoggedIn = this.isLoggedIn();
    const isAuthRoute = route.split('/')[1] === 'auth' && !isLoggedIn;
    const isDeskRoute = route.split('/')[1] === 'desk' && isLoggedIn;
    const wsPrefix = isDeskRoute
      ? ""
      : (this.workspace === "desk" ? `/${this.workspace}` : "");

    return isAuthRoute ? route : wsPrefix + route;
  }

  isLoggedIn() {
    return !!(this.user && this.user.name);
  }

  get user() {
    // Provider-bound session (reactive: login modal / logout update it via
    // _bindSession). Unbound → guest ({}).
    return this.#user || {};
  }
}

export function createRouter() {
  return Object.freeze(new Router());
}
