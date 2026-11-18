'use strict'

import { BaseController, loopar } from "loopar";
import { resetMfa } from "../../controllers/auth/mfa.js";

const ADMIN = 'Administrator';
const ADMIN_READ_ACTIONS = new Set(['view', 'list', 'search', 'print', 'history', 'export']);

export default class UserController extends BaseController {
  static freeActions=["profile"]
  static postOnlyActions = ["resetMfa"]
  constructor(props) {
    super(props);
  }

  /**
   * Only the Administrator changes the Administrator account: password, email,
   * 2FA, any field. A System Manager may see it but not take it over (and lock
   * the server owner out of the tenant). Opening its form shows it read-only.
   */
  async isAuthorized(user) {
    const authorized = await super.isAuthorized(user);
    if (user?.name === ADMIN || !this.#targetsAdministrator()) return authorized;

    const action = String(this.action).toLowerCase();
    if (ADMIN_READ_ACTIONS.has(action)) return authorized;
    if (action === 'update' && !this.hasData() && typeof this.actionView === 'function') {
      this.action = 'view';
      return authorized;
    }
    loopar.throw({ code: 403, message: 'Only the Administrator can change the Administrator account.' });
  }

  #targetsAdministrator() {
    if ((this.query?.name ?? this.name) === ADMIN) return true;
    const raw = this.body?.names;
    const names = Array.isArray(raw) ? raw : (loopar.utils.isJSON(raw) ? JSON.parse(raw) : []);
    return names.includes(ADMIN);
  }

  async actionUpdate() {
    this.entry ??= 'form';
    // Field write policy (layer A, applied by getDocument): email/password are
    // `protected` and the mfa_* / oauth_* / reset fields `system` — never
    // taken from the form.
    const document = await loopar.getDocument("User", this.name, this.hasData() ? this.data : null);

    if (!this.hasData()) {
      document.password = document.protectedPassword;
      document.confirm_password = document.protectedPassword;
    }
    return await super.actionUpdate(document);
  }

  actionLogout() {
    loopar.session.destroy();
    this.redirect('/login/login');
  }

  /**
   * POST User/resetMfa?name=<user> — turns 2FA off for a user who lost the
   * phone and the recovery codes. Needs the `resetMfa` grant on User
   * (Administrator always has it).
   */
  async actionResetMfa() {
    if (!this.name) loopar.throw('User is required.');
    await resetMfa(this.name);
    return this.success(`Two-factor authentication was reset for ${this.name}`);
  }

  async actionGetRoles(){
    return await loopar.db.getAll("Role", ["name"])
  }

  async actionGetUserRoles(){
    return await loopar.db.getAll("User Role", ["role"], {user: this.query.userId})
  }

  async publicActionProfile(){
    this.client = "form"
    const user = await loopar.newDocument("Profile")

    return await super.render(user)
  }
}