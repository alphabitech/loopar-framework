'use strict';

/**
 * SFTP destination (any SSH server: a VPS, a NAS, Hetzner Storage Box…).
 * Password or private key. The key is a file the server operator put in
 * config/backup-keys/ (multi-line keys don't survive a password input, and a
 * site must not be able to point at any file of the server). Needs `ssh2`.
 */

import fs from 'node:fs';
import path from 'node:path';

export const KEYS_DIR = path.join('config', 'backup-keys');

/** A key name inside config/backup-keys/ (no folders, no links out). */
export function keyFile(name, root = process.cwd()) {
  const dir = path.join(root, KEYS_DIR);
  const base = path.basename(String(name));
  if (!base || base !== String(name).trim() || base.startsWith('.')) {
    throw new Error(`SFTP destination: the private key must be a file name in ${KEYS_DIR}/.`);
  }
  let real;
  try { real = fs.realpathSync(path.join(dir, base)); } catch {
    throw new Error(`SFTP destination: ${KEYS_DIR}/${base} not found.`);
  }
  if (path.dirname(real) !== fs.realpathSync(dir)) throw new Error(`SFTP destination: the private key must be a file in ${KEYS_DIR}/.`);
  return real;
}

export class SftpDestination {
  name = 'sftp';

  constructor(s) {
    if (!s.sftp_host || !s.sftp_username) throw new Error('SFTP destination: host and username are required.');
    if (!s.sftp_password && !s.sftp_key_path) throw new Error('SFTP destination: a password or a private key path is required.');
    this.s = s;
    this.root = String(s.sftp_path || 'loopar-backups').replace(/\/+$/, '') || '.';
  }

  async #session(fn) {
    let Client;
    try {
      const mod = await import('ssh2');
      Client = mod.Client ?? mod.default?.Client; // CommonJS package
    } catch {
      throw new Error('SFTP backups need the "ssh2" package: run `yarn install`.');
    }
    const s = this.s;
    const client = new Client();
    const opts = { host: s.sftp_host, port: Number(s.sftp_port) || 22, username: s.sftp_username, readyTimeout: 20000 };
    if (s.sftp_key_path) opts.privateKey = fs.readFileSync(keyFile(s.sftp_key_path));
    if (s.sftp_password) {
      if (opts.privateKey) opts.passphrase = s.sftp_password; else opts.password = s.sftp_password;
    }
    await new Promise((resolve, reject) => {
      client.once('ready', resolve).once('error', reject).connect(opts);
    });
    try {
      const sftp = await new Promise((resolve, reject) => client.sftp((e, sf) => (e ? reject(e) : resolve(sf))));
      const call = (method, ...args) => new Promise((resolve, reject) => sftp[method](...args, (e, r) => (e ? reject(e) : resolve(r))));
      return await fn(call);
    } finally {
      client.end();
    }
  }

  #dir(tenant) {
    return path.posix.join(this.root, tenant);
  }

  async #mkdirp(call, dir) {
    let cur = dir.startsWith('/') ? '/' : '';
    for (const part of dir.split('/').filter(Boolean)) {
      cur = cur ? path.posix.join(cur, part) : part;
      try { await call('stat', cur); } catch { await call('mkdir', cur).catch(() => {}); }
    }
  }

  async upload(localFile, tenant, file) {
    await this.#session(async (call) => {
      await this.#mkdirp(call, this.#dir(tenant));
      const final = path.posix.join(this.#dir(tenant), file);
      const part = `${final}.part`;
      await call('fastPut', localFile, part);
      await call('unlink', final).catch(() => {});
      await call('rename', part, final);
    });
  }

  async download(tenant, file, localFile) {
    await this.#session((call) => call('fastGet', path.posix.join(this.#dir(tenant), file), localFile));
  }

  async remove(tenant, file) {
    await this.#session((call) => call('unlink', path.posix.join(this.#dir(tenant), file)).catch((e) => { if (e.code !== 2) throw e; }));
  }

  async list(tenant) {
    return await this.#session(async (call) => {
      let entries = [];
      try { entries = await call('readdir', this.#dir(tenant)); } catch { return []; }
      return entries
        .filter((e) => !e.longname?.startsWith('d') && !e.filename.endsWith('.part'))
        .map((e) => ({ file: e.filename, size: e.attrs?.size || 0, modifiedAt: e.attrs?.mtime ? new Date(e.attrs.mtime * 1000).toISOString() : null }));
    });
  }
}
