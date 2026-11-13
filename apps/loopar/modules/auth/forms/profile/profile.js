
'use strict';

import {BaseDocument, loopar} from 'loopar';
import { systemPolicy, passwordProblem } from 'loopar/core/global/system-policy.js';

export default class Profile extends BaseDocument {
  constructor(props){
      super(props);
  }

  async rawValues() {
    return await loopar.db.getDoc("User", loopar.auth.user(), [
      "name", "email", "disabled", "profile_picture", "first_name", "last_name", "phone", "language", "user_type"
    ]);
  }

  async changePassword({ current_password, new_password, confirm_password }) {
    if (!current_password || !new_password || !confirm_password) {
      loopar.throw('All fields are required.');
    }

    if (new_password !== confirm_password) {
      loopar.throw('New password and confirmation do not match.');
    }

    // System Settings → Security decides the length and complexity required.
    const problem = passwordProblem(new_password, await systemPolicy());
    if (problem) loopar.throw(problem);

    const user = await loopar.getDocument('User', loopar.auth.user());

    if (!await loopar.verifyHash(current_password, user.password)) {
      loopar.throw('Current password is incorrect.');
    }

    // The current password was just verified: that is the step-up for this
    // protected change (write_policy), so authorize it explicitly.
    user.authorize('password', 'confirm_password');
    user.password = new_password;
    user.confirm_password = confirm_password;
    await user.save();
  }

  /**
   * The fields the profile's own "updateInfo" form declares — the ONLY ones
   * it may write on the user's record. Profile is a proxy: it is authorized
   * as Profile (any logged user) but writes User, so it must never forward the
   * rest of the body (it once did: any user could post `user_type: "System"`,
   * `mfa_enabled: 0`, `oauth_sub: …`). Derived from the form JSON, so adding a
   * field to the form in the designer is all it takes.
   */
  #updateInfoFields() {
    const structure = loopar.utils.JSONparse(this.__ENTITY__?.doc_structure, []);
    const findForm = (nodes = []) => {
      for (const node of nodes) {
        if (node?.element === 'form' && node.data?.action === 'updateInfo') return node;
        const found = findForm(node?.elements || []);
        if (found) return found;
      }
      return null;
    };
    const names = new Set();
    const collect = (nodes = []) => {
      for (const node of nodes) {
        if (node?.data?.name) names.add(node.data.name);
        collect(node?.elements || []);
      }
    };
    collect(findForm(structure)?.elements || []);
    return names;
  }

  /**
   * Protected fields shown on the profile (email) are the user's own User
   * fields: the verified change is User's (confirmation link for the email).
   * Reached through Profile/changeProtected after re-authentication.
   */
  async changeProtectedField(field, value, opts = {}) {
    const name = loopar.auth.user();
    const user = await loopar.getDocument('User', name);
    const result = await user.changeProtectedField?.(field, value, { ...opts, actor: name });
    if (result !== null && result !== undefined) return result;

    user.authorize(field);
    user[field] = value;
    user.password = user.protectedPassword;
    user.confirm_password = user.protectedPassword;
    await user.save();
    return { message: 'Updated successfully' };
  }

  async updateInfo(data = {}) {
    const picked = {};
    for (const field of this.#updateInfoFields()) {
      if (field in data) picked[field] = data[field];
    }
    // Uploaded / imported picture binaries travel next to the fields.
    if (data.__REQ_FILES__) picked.__REQ_FILES__ = data.__REQ_FILES__;
    if (data.__REMOTE_FILES__) picked.__REMOTE_FILES__ = data.__REMOTE_FILES__;

    // ...and of those, getDocument keeps only what User's write policy lets
    // this user write (email is `protected`: verified flow only).
    const user = await loopar.getDocument('User', loopar.auth.user(), picked);
    user.password = this.protectedPassword;
    user.confirm_password = this.protectedPassword;
    await user.save();
  }
}