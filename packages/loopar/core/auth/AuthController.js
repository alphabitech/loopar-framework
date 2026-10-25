import { loopar, PermissionManager, CREATED_BY_COLUMN } from "loopar";
import { SCOPE } from "./PermissionManager.js";
import { validateCsrfToken } from './csrf.js';
import { workspaceCapabilities, workspaceRequiresAuth, getWorkspaceName } from "../global/router-utils.js";

export default class AuthController {
  async validateCsrf() {
    if (this.method === 'GET') return true;

    if (this.#isPublicAction(this.req.__WORKSPACE_NAME__)) return true;

    if (this.#isRpc) {
      if (!validateCsrfToken(this.req)) {
        loopar.throw('Invalid CSRF token', '/auth/login');
      }
      return true;
    }

    const workspace = this.req.__WORKSPACE_NAME__;
    if (!workspaceCapabilities(workspace).enforceCsrf) return true;

    if (!validateCsrfToken(this.req)) {
      loopar.throw('Invalid CSRF token', '/auth/login');
    }

    return true;
  }

  /** RPC mode: workspace-less /{Document}/{action} routed by middleware. */
  get #isRpc() {
    return this.req?.__ROUTE_MODE__ === 'rpc';
  }

  #isPublicAction(workspace){
    if(workspace == "web" && !this.#isRpc) return true;
    const method = this[`publicAction${loopar.utils.Capitalize(this.action)}`];
    if(method && typeof method == "function" && !this.isRevokedPublicAction(this.action)) return true;

    return false;
  }

  // ---- Revocable public actions ---------------------------------------------
  // "Public" means "a publicAction<X> method exists" — and methods are
  // inherited, so a subclass exposes every public action of its parents.
  // A controller can withdraw some of them (statically or depending on
  // state): a revoked action is neither public (auth + CSRF apply) nor
  // dispatched to publicAction<X>; it resolves to action<X> if the class
  // defines one, otherwise it is a plain 404 like any missing action.

  /** Static, inherited list: `static revokedPublicActions = ['connect']`. */
  static revokedPublicActions = [];

  /** Override for state-dependent revocation (call super and extend). */
  revokedPublicActions() {
    return this.constructor.revokedPublicActions || [];
  }

  isRevokedPublicAction(action) {
    const a = String(action ?? '').toLowerCase();
    return this.revokedPublicActions().some((r) => String(r).toLowerCase() === a);
  }

  #document = null;
  #action = null;
  #name = null;
  #query = {}

  constructor(props) {
    Object.assign(this, props);
  }

  set document(document) {this.#document = document}
  get document() {return this.#document}
  set query(query){this.#query = query}
  get query(){return this.#query || {}}
  set action(action){this.#action = action}
  get action(){return this.#action};
  set name(name){this.#name = name};
  get name(){ return this.#name}

  __execute() {
    const action = this.action;
    const data = this.data;

    if (this.publicActions.includes(action)) {
      this.__login(action, data);
    } else {
      this.__logout();
    }
  }

  // ---- Ownership (record-level scope) --------------------------------------
  // A grant carries a scope: 'all' (default) or 'own'. Ownership never grants
  // access on its own — the action grant comes first, 'own' only narrows it to
  // the records the user owns. Evaluated ONLY for the request's own
  // (document, action, name); documents a controller loads internally are
  // never gated here (Invoice.update reading Materials is not a Material
  // request). Lists are narrowed by `ownerFilters()` in BaseController.

  /** Column that identifies the owner. Override per entity (e.g. 'customer'). */
  static ownerField = CREATED_BY_COLUMN;

  get ownerField() {
    return this.constructor.ownerField || CREATED_BY_COLUMN;
  }

  /** Effective scope for this request: 'all' | 'own' | null. */
  ownerScope(user = loopar.auth.user()) {
    return PermissionManager.scope(this.document, this.action, user);
  }

  /** Filter to narrow a list to the user's records. Override for compound rules (may be async). */
  async ownerCondition(user = loopar.auth.user()) {
    return { [this.ownerField]: user ?? '__nobody__' };
  }

  /** `ownerCondition()` when the request's scope is 'own', else null. */
  async ownerFilters(user = loopar.auth.user()) {
    return this.ownerScope(user) === SCOPE.OWN ? await this.ownerCondition(user) : null;
  }

  /**
   * Is `user` the owner of record `name`? Override for compound rules.
   * Returns null when the record doesn't exist so the action can 404 as usual.
   */
  async isOwner(name, user = loopar.auth.user()) {
    const row = await loopar.db.getRow(this.document, name, [this.ownerField]);
    if (!row) return null;
    const owner = row[this.ownerField];
    return owner != null && owner === user;
  }

  /** Record names targeted by this request (single `name`, or bulk `names`). */
  #targetNames() {
    if (this.name) return [this.name];
    const raw = this.body?.names ?? this.data?.names;
    if (Array.isArray(raw)) return raw;
    if (loopar.utils.isJSON(raw)) {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    }
    return [];
  }

  async #assertOwnership(user) {
    for (const name of this.#targetNames()) {
      const owns = await this.isOwner(name, user.name);
      if (owns === false) {
        loopar.throw({
          code: 403,
          message: 'You do not have permission over this record',
        });
      }
    }
  }

  /** A plain GET of `update` (opening the record, not saving it). */
  #canDowngradeToView() {
    return String(this.action).toLowerCase() === 'update'
      && String(this.method || 'GET').toUpperCase() === 'GET'
      && typeof this.actionView === 'function';
  }

  async isAuthorized(user) {
    if (user.name === 'Administrator') return true;
    const workspace = this.req.__WORKSPACE_NAME__;

    if (this.#isPublicAction(workspace)) return true;

    if ((this.freeActions || []).includes(this.action)) return true;

    let scope = PermissionManager.scope(
      this.document,
      this.action,
      user.name,
    );

    if(this.document == "Module"){
      // Opening a module (`Module/view?name=x`) is allowed when the user can
      // reach any document in it (or has `Module:x view` / `Module:<action>`).
      const isViewLike = ['view', 'list'].includes(String(this.action).toLowerCase());
      scope = (isViewLike && this.name && PermissionManager.canAccessModule(this.name, user.name))
        ? SCOPE.ALL
        : PermissionManager.scope("Module", this.action, user.name);
    }

    // Opening a record to edit without the update permission: show it
    // read-only (`view`) when the user may see it, instead of refusing.
    if (!scope && this.#canDowngradeToView()) {
      const viewScope = PermissionManager.scope(this.document, 'view', user.name);
      if (viewScope) {
        this.action = 'view';
        scope = viewScope;
      }
    }

    if (!scope) {
      loopar.throw(
        'You do not have permission to perform this action'
      );
    }

    if (scope === SCOPE.OWN) {
      await this.#assertOwnership(user);
    }

    return true;
  }

  async #award() {
    const action = this.action;
    const workspace = this.req.__WORKSPACE_NAME__;

    const cap = workspaceCapabilities(workspace);

    const isApi = workspace === 'api';
    const resolve = (message, url) => loopar.throw(
      message,
      isApi ? null : (url || '/auth/login')
    );

    if (this.#isRpc) {
      if (this.#isPublicAction(workspace)) return true;

      const user = await loopar.auth.award();
      if (!user) return resolve('You must be logged in to perform this action');

      if (user.name !== 'Administrator' && user.disabled) {
        return resolve('Not permitted');
      }

      if (cap.blockWebUsers && user.user_type === 'Web') {
        return resolve('This account does not have desk access');
      }

      return await this.isAuthorized(user);
    }

    // Fully public surfaces (web, loopar): no auth gate at all (navigation).
    if (cap.public) return true;

    const AUTH_FORM_ACTIONS = ['login', 'register', 'recoveryuser', 'recoverypassword', 'recoverypasswordrequest'];
    if (
      cap.isAuth &&
      this.method === 'GET' &&
      AUTH_FORM_ACTIONS.includes(String(action).toLowerCase())
    ) {
      const current = await loopar.auth.award();
      if (current?.name) {
        const webLanding = process.env.WEB_LANDING || '/';
        return resolve('You are already logged in', current.user_type === 'Web' ? webLanding : '/desk');
      }
    }

    if (this.#isPublicAction(workspace)) return true;

    const user = await loopar.auth.award();

    if (user) {
      const webLanding = process.env.WEB_LANDING || '/';

      if (cap.isAuth && action !== 'logout') {
        const dest = user.user_type === 'Web' ? webLanding : '/desk/Desk/view';
        return resolve('You are already logged in, refresh this page', dest);
      }

      if (user.name !== 'Administrator' && user.disabled) {
        return resolve('Not permitted');
      }

      if (cap.blockWebUsers && user.user_type === 'Web') {
        return resolve('This account does not have desk access', webLanding);
      }

      return await this.isAuthorized(user);
    }

    if (cap.isAuth) return true;
    if (cap.requiresAuth) {
      // On a full-page GET the requested URL IS the page the user was on —
      // carry it as ?redirect=. On AJAX `originalUrl` is the fetch/RPC url,
      // not the page: the client appends its own location instead.
      let url = '/auth/login';
      if (String(this.method).toUpperCase() === 'GET') {
        const back = this.req?.originalUrl || '';
        if (back && workspaceRequiresAuth(getWorkspaceName(back))) {
          url += `?redirect=${encodeURIComponent(back)}`;
        }
      }
      return resolve('You must be logged in to access this page', url);
    }

    return resolve('You must be logged in to access this page');
  }

  static GET_UNSAFE_ACTIONS = new Set(['delete', 'bulkdelete']);

  /**
   * On GET/HEAD, block the state-changing actions above. This closes the
   * CSRF-via-GET hole on BOTH channels (navigation `/desk/...` and the RPC
   * `/api/...` surface reach `validateCsrf`, which exempts GET) without
   * blocking page renders reached on a GET reload.
   */
  #assertGetSafety() {
    const method = String(this.method || '').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') return;

    const action = String(this.action || '').toLowerCase();
    const postOnly = (this.constructor?.postOnlyActions || []).map(a => String(a).toLowerCase());
    if (!AuthController.GET_UNSAFE_ACTIONS.has(action) && !postOnly.includes(action)) return;

    loopar.throw({
      code: 404,
      message: `Action "${this.action}" is not available over GET \u2014 mutations must use loopar.call (POST).`,
    });
  }

  async beforeAction() {
    this.#assertGetSafety();
    return await this.#award() && await this.validateCsrf();
  }
}