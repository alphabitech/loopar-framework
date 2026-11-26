'use strict';

import { loopar, BaseDocument } from 'loopar';
import { inspectToken } from '../app-manager/github-api.js';

/**
 * A personal git-hosting credential. Each account belongs to the user who
 * created it (`__created_by__`) and is only ever visible to / used for that
 * user — see GitAccountController and resolveGitAccount().
 */
export default class GitAccount extends BaseDocument {
  constructor(props) {
    super(props);
  }

  get #tokenChanged() {
    return !!this.token && this.token !== this.protectedPassword;
  }

  async save(opts) {
    const user = loopar.auth.user();
    const owner = this.__IS_NEW__
      ? user
      : (await loopar.db.getValue('Git Account', '__created_by__', this.__DOCUMENT_NAME__)) || user;

    if (this.__IS_NEW__ || this.#tokenChanged) {
      if (!this.#tokenChanged) loopar.throw('An access token is required.');
      const info = await inspectToken(this.token);

      if (!this.__IS_NEW__ && this.username && info.login !== this.username) {
        loopar.throw(`This token belongs to "${info.login}", not "${this.username}". Create a separate account for it.`);
      }

      this.provider ||= 'github';
      this.username = info.login;
      this.author_name ||= info.name;
      this.author_email ||= info.email;
      this.owners = info.owners.join('\n');
      this.token_expires_at = info.expiresAt || '';

      if (this.__IS_NEW__) {
        this.name = `${this.provider}:${info.login}`;
        const existing = await loopar.db.getDoc('Git Account', this.name, ['name', '__created_by__']);
        if (existing) {
          loopar.throw(existing.__created_by__ === user
            ? `You already have the account ${this.name}. Edit it to update its token.`
            : `${this.name} is already linked by another user.`);
        }
      }
    }

    // Exactly one default per user.
    const mine = await loopar.db.getAll('Git Account', ['name', 'is_default'], { __created_by__: owner });
    const others = mine.filter(a => a.name !== this.name);
    if (Number(this.is_default)) {
      for (const a of others.filter(a => Number(a.is_default))) {
        await loopar.db.setValue('Git Account', 'is_default', 0, a.name);
      }
    } else if (!others.some(a => Number(a.is_default))) {
      this.is_default = 1;
    }

    return await super.save(opts);
  }
}
