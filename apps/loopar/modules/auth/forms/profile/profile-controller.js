
'use strict';

import {PageController, loopar} from 'loopar';
import {mfaStatus, beginSetup, confirmSetup, disableMfa, regenerateRecoveryCodes} from '../../controllers/auth/mfa.js';

export default class ProfileController extends PageController {
  // `update` is a free action (any logged user, no role grant needed) —
  // NOT a public one: public actions skip CSRF, and saving a profile is a
  // state change of the logged user.
  static freeActions = [
    "view", "update", "setInfo", "updateInfo", "changePassword", "changeProtected",
    "mfaStatus", "mfaSetup", "mfaEnable", "mfaDisable", "mfaRegenerateCodes",
  ]
  // State changes: POST only, so the CSRF check always applies.
  static postOnlyActions = ["mfaSetup", "mfaEnable", "mfaDisable", "mfaRegenerateCodes"]
  constructor(props){
    super(props);

    const user = loopar.auth.user();

    if(!user) loopar.throw("Not logued", "/auth/login")
  }

  async actionView(){
    this.client = "profile"
    this.entry = "form"; // desk form; profile-form.jsx sets canUpdate/hasHeader
    const user = await loopar.newDocument("Profile")

    return await super.render(user)
  }

  /** Protected changes (email) apply to the logged user's own record. */
  async protectedChangeTarget() {
    return await loopar.newDocument("Profile");
  }

  clientImporter(Document) {
    return "profile-form"
  }

  async actionUpdateInfo(){
    const profile = await loopar.newDocument("Profile");
    const before = (await profile.rawValues())?.language || "";
    await profile.updateInfo(this.body)

    // A new language needs a full reload: the page's dictionary is loaded
    // before hydration. Reload IN PLACE (`refresh: 'hard'` → the client
    // reloads its own URL). It used to rebuild the URL from the Referer, but
    // the client sends `referrerPolicy: 'no-referrer'`, so it always fell
    // back to /desk — saving the profile "redirected to the desk".
    if ("language" in (this.body || {}) && (this.body.language || "") !== (before || "")) {
      return this.reload();
    }

    return this.success("Completed")
  }

  async actionChangePassword(){
    const profile = await loopar.newDocument("Profile");
    await profile.changePassword(this.body);

    return this.success("Completed")
  }

  /* ------------------------- two-factor authentication ------------------------ */

  /** Name shown in the authenticator app next to the account. */
  #mfaIssuer() {
    const host = String(this.req?.headers?.host || '').split(':')[0];
    return process.env.MFA_ISSUER || host || 'Loopar';
  }

  #mfaFactor() {
    const { code, recovery_code } = this.body || {};
    return { code, recovery_code };
  }

  async actionMfaStatus() {
    return this.success('ok', { ...await mfaStatus(loopar.auth.user()), notify: false });
  }

  async actionMfaSetup() {
    const setup = await beginSetup(loopar.auth.user(), { issuer: this.#mfaIssuer() });
    return this.success('ok', { ...setup, notify: false });
  }

  async actionMfaEnable() {
    const { recovery_codes } = await confirmSetup(loopar.auth.user(), this.body?.code);
    return this.success('Two-factor authentication enabled', { recovery_codes });
  }

  async actionMfaDisable() {
    await disableMfa(loopar.auth.user(), this.#mfaFactor());
    return this.success('Two-factor authentication disabled');
  }

  async actionMfaRegenerateCodes() {
    const { recovery_codes } = await regenerateRecoveryCodes(loopar.auth.user(), this.#mfaFactor());
    return this.success('New recovery codes generated', { recovery_codes });
  }
}
