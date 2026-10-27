'use strict'

import { BaseDocument, loopar } from "loopar";

export default class Login extends BaseDocument {
  constructor(props) {
    super(props);
  }

  /**
   * First factor only: returns the User row when the credentials are valid.
   * The session is opened by the controller (auth/mfa.js completeLogin),
   * which may still ask for a second factor.
   */
  async verifyCredentials() {
    const user = await loopar.auth.getUser(this.user_name);
  
    const storedHash = user?.password ?? await loopar.hash('dummy');
    const isValidPassword = await loopar.verifyHash(this.password, storedHash);
  
    if (user && isValidPassword && !(user.disabled && user.name !== 'Administrator') &&
      (this.user_name === user.name || this.user_name === user.email)
    ) {
      return user;
    } else {
      loopar.auth.killSession();
      loopar.throw({ code: 401, title: 'Login Error', message: 'Invalid user or password' });
    }
  }

  async logout() {
    loopar.auth.killSession();
  }
}