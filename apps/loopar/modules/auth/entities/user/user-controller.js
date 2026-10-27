'use strict'

import { BaseController, loopar } from "loopar";
import { resetMfa } from "../../controllers/auth/mfa.js";

export default class UserController extends BaseController {
  static freeActions=["profile"]
  static postOnlyActions = ["resetMfa"]
  constructor(props) {
    super(props);
  }

  async actionUpdate() {
    this.entry ??= 'form';
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