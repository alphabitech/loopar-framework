
'use strict';

import {PageController, loopar} from 'loopar';
import {mfaStatus, beginSetup, confirmSetup, disableMfa, regenerateRecoveryCodes} from '../../controllers/auth/mfa.js';

export default class ProfileController extends PageController {
  // `update` is a free action (any logged user, no role grant needed) —
  // NOT a public one: public actions skip CSRF, and saving a profile is a
  // state change of the logged user.
  static freeActions = [
    "view", "update", "setInfo", "changePassword",
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

  clientImporter(Document) {
    return "profile-form"
  }

  async actionUpdateInfo(){
    const profile = await loopar.newDocument("Profile");
    await profile.updateInfo(this.body)

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
