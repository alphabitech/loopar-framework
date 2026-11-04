'use strict';

import { loopar, BaseDocument } from 'loopar';

/**
 * Backup Settings (single): schedule, retention, encryption and the remote
 * destination of this site's backups. Read by the backup engine
 * (core/backup) — in the core and, without the framework, by the CLI/TUI.
 */
export default class BackupSettings extends BaseDocument {
  constructor(props) {
    super(props);
  }

  async validate(opts) {
    if (this.at && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(String(this.at).trim())) {
      loopar.throw('"At" must be a time like 02:30.');
    }
    const destination = String(this.destination || 'local');
    if (destination !== 'local' && Number(this.encrypt) && !this.passphrase) {
      loopar.throw('Set an encryption passphrase before sending backups to a remote destination (or turn encryption off).');
    }
    return await super.validate(opts);
  }
}
