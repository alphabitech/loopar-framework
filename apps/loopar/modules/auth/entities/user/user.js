'use strict'

import { assertUserLimit } from 'loopar/core/auth/tenant-limits.js';
import { BaseDocument, loopar, Op, setLanguageCookie } from "loopar";
import { requestEmailChange, adminSetEmail } from "../../controllers/auth/email-change.js";

export default class User extends BaseDocument {
  constructor(props) {
    super(props);
  }

  validatePasswordStrong(password) {
    const strongRegex = new RegExp("^(?=.*[a-z])(?=.*[A-Z])(?=.*[0-9])(?=.*[!@#\$%\^&\*])(?=.{8,})");
    if (!strongRegex.test(password)) {
      loopar.throw('Password must be at least 8 characters and include uppercase, lowercase, number and special character.');
    }
  }

  async validateUserName() {
    // `name` is the document ID: either an email (web signup) or a plain
    // username (e.g. "Administrator"). The person's name lives in first_name/last_name.
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const usernameRegex = /^[\p{L}\p{N}._-]{3,}$/u;
    const personNameRegex = /^[\p{L} '\-]+$/u;

    const excludeSelf = this.id ? { id: { [Op.ne]: this.id } } : {};

    const name = (this.name || '').trim();
    if (!emailRegex.test(name) && !usernameRegex.test(name)) {
      loopar.throw('User name must be a valid email or at least 3 characters (letters, numbers, ".", "_" or "-").');
    }

    for (const field of ['first_name', 'last_name']) {
      const value = (this[field] || '').trim();
      if (value && !personNameRegex.test(value)) {
        loopar.throw(`${field === 'first_name' ? 'First' : 'Last'} name may only contain letters, spaces, apostrophes and hyphens.`);
      }
    }

    if (!loopar.installing && this.__IS_NEW__ && this.name === 'Administrator') {
      loopar.throw('User name "Administrator" is not allowed');
    }

    if (await loopar.db.getValue('User', 'id', { name: this.name, ...excludeSelf })) {
      loopar.throw(`The name <strong>${this.name}</strong> is invalid`);
    }

    if (await loopar.db.getValue('User', 'id', { email: this.email, ...excludeSelf })) {
      loopar.throw(`The email <strong>${this.email}</strong> is invalid`);
    }
  }

  async validate() {
    if (this.disabled && this.name === 'Administrator') {
      loopar.throw('The "Administrator" user cannot be disabled.');
    }

    if (this.disabled && this.name == loopar.auth.authUser()?.name) {
      loopar.throw('You cannot disable your own account.');
    }

    await super.validate();
    await this.validateUserName();
    await assertUserLimit(this);
  }

  async save() {
    const password = this.password;
    const confirmPassword = this.confirm_password;

    if (password !== confirmPassword) {
      loopar.throw('The password and confirmation password do not match.');
    }

    // Hashing is done by the core (password fields in `hash` mode). For an
    // existing user, an empty password means "unchanged", not "remove it".
    if (!this.__IS_NEW__ && !password) {
      this.password = this.protectedPassword;
      this.confirm_password = this.protectedPassword;
    }

    await super.save(arguments[0]);

    // Saving your own language switches the desk to it on the next load.
    if (this.name === loopar.auth.authUser()?.name) setLanguageCookie(this.language);
  }

  /**
   * `protected` fields of a user (write_policy), reached through
   * <Entity>/changeProtected AFTER the actor re-authenticated:
   *  - email: on your own account → confirmation link to the new address
   *    (the change happens when it is opened); on someone else's (an admin
   *    with `update` on User) → direct change + notice to the old address.
   *  - password: new value + confirmation, strength rules apply.
   */
  async changeProtectedField(field, value, { confirm, actor } = {}) {
    if (field === 'email') {
      return actor === this.name
        ? await requestEmailChange(this.name, value)
        : await adminSetEmail(this.name, value);
    }

    if (field === 'password' || field === 'confirm_password') {
      const password = String(value ?? '');
      if (!password || password !== String(confirm ?? '')) {
        loopar.throw('The password and confirmation password do not match.');
      }
      this.validatePasswordStrong(password);
      this.authorize('password', 'confirm_password');
      this.password = password;
      this.confirm_password = password;
      await this.save();
      return { message: 'Password updated.' };
    }

    return null;
  }

  async delete() {
    if (this.name === 'Administrator') {
      loopar.throw('The "Administrator" user cannot be deleted.');
      return;
    }

    await super.delete();
  }
}