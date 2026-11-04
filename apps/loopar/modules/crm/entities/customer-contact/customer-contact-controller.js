'use strict';

import { BaseController, loopar } from 'loopar';
import { grantPortalAccess, revokePortalAccess } from '../../portal-access.js';

export default class CustomerContactController extends BaseController {
  static postOnlyActions = ['grantPortal', 'revokePortal'];

  constructor(props) {
    super(props);
  }

  #target() {
    const name = this.query?.name || this.body?.name;
    if (!name) loopar.throw({ code: 400, message: 'Missing contact.' });
    return name;
  }

  /**
   * Gives the contact a Web user for the portals. A new user gets a
   * temporary password, returned once so staff can hand it over.
   */
  async actionGrantPortal() {
    // No `message` key: the client gets the whole payload (http.jsx collapses messages).
    return { ...(await grantPortalAccess(this.#target(), { password: 'temporary' })), refresh: 'soft' };
  }

  /** Unlinks the contact's portal user (the user is kept, it just sees no customer). */
  async actionRevokePortal() {
    await revokePortalAccess(this.#target());
    return await this.success('Portal access removed.', { refresh: 'soft' });
  }
}
