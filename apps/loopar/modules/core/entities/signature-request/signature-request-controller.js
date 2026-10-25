'use strict';

import { BaseController, loopar } from 'loopar';
import SignatureRequest from './signature-request.js';

/**
 * Public actions authenticate with the link token (no session); desk actions
 * (`resend`, `revoke`) need their own grants.
 */
export default class SignatureRequestController extends BaseController {
  constructor(props) {
    super(props);
  }

  async #request() {
    const token = this.data?.token || this.query?.token;
    const request = await SignatureRequest.byToken(token);
    if (!request) loopar.throw({ code: 404, message: 'This signing link is not valid. Ask the sender for a new one.' });
    return request;
  }

  // Data endpoints: no `message` key, so the client keeps the payload.
  async publicActionDocument() {
    return { request: await (await this.#request()).publicView() };
  }

  async publicActionSign() {
    const request = await this.#request();
    await request.sign(this.data || {});
    return { request: await request.publicView() };
  }

  async publicActionDecline() {
    const request = await this.#request();
    await request.decline(this.data || {});
    return { request: await request.publicView() };
  }

  /** New link, emailed again; the link is returned once so staff can share it another way. */
  async actionResend() {
    const request = await loopar.getDocument('Signature Request', this.name);
    const { url, emailed } = await request.rotate({ email: true });
    return { url, emailed };
  }

  async actionRevoke() {
    const request = await loopar.getDocument('Signature Request', this.name);
    await request.revoke();
    return await this.success('Signature request revoked.');
  }
}
