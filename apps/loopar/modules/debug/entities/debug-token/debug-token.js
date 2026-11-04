'use strict';

import { loopar, BaseDocument } from 'loopar';
import { MINTING, TOKEN_ENTITY } from '../../debug-tokens.js';

/**
 * A bearer credential for the Debugger API (see ../../debug-tokens.js).
 * Tokens are minted only by createToken (Debugger page → API access), which
 * shows the plaintext once. The desk form can rename (label) or disable a
 * token; its hash, scope and expiry are fixed at creation — a grant on this
 * entity must never be a way to forge a token or widen one.
 */
export default class DebugToken extends BaseDocument {
  constructor(props) {
    super(props);
  }

  async save(opts) {
    if (this.__IS_NEW__) {
      if (!this[MINTING]) {
        loopar.throw('Create debug tokens from the Debugger page (API access tab): the token is shown only there, once.');
      }
      return await super.save(opts);
    }

    const stored = await loopar.db.getDoc(TOKEN_ENTITY, this.__DOCUMENT_NAME__ || this.name, ['name', 'token_hash', 'scope', 'expires_at', 'token_hint']);
    if (!stored) loopar.throw({ code: 404, message: 'Debug token not found.' });
    this.name = stored.name;
    this.token_hash = stored.token_hash;
    this.scope = stored.scope;
    this.expires_at = stored.expires_at;
    this.token_hint = stored.token_hint;
    return await super.save(opts);
  }
}
