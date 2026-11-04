'use strict';

/**
 * Backup encryption — AES-256-GCM over the whole archive, key from a
 * passphrase (scrypt). The passphrase is the admin's, not the tenant's
 * secretKey: the tenant's config.json travels INSIDE the archive, so a key
 * derived from it would ship with the lock it opens.
 *
 * File layout:  MAGIC(8) | version(1) | salt(16) | iv(12) | ciphertext | tag(16)
 */

import fs from 'node:fs';
import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const MAGIC = Buffer.from('LOOPARBK');
const VERSION = 1;
const HEADER = MAGIC.length + 1 + 16 + 12;
const TAG = 16;
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function deriveKey(passphrase, salt) {
  if (!passphrase) throw new Error('A passphrase is required for an encrypted backup.');
  return crypto.scryptSync(String(passphrase), salt, 32, SCRYPT);
}

/** Does `file` start with the encrypted-backup header? */
export function isEncryptedFile(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(MAGIC.length);
    fs.readSync(fd, buf, 0, MAGIC.length, 0);
    return buf.equals(MAGIC);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Encrypt `src` into `dest` (streaming). */
export async function encryptFile(src, dest, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
  const out = fs.createWriteStream(dest);
  out.write(Buffer.concat([MAGIC, Buffer.from([VERSION]), salt, iv]));
  await pipeline(fs.createReadStream(src), cipher, out, { end: false });
  await new Promise((resolve, reject) => out.end(cipher.getAuthTag(), (e) => (e ? reject(e) : resolve())));
}

/**
 * A readable stream of the plaintext of an encrypted backup. The GCM tag is
 * checked when the stream ends: a wrong passphrase or a tampered file makes
 * the stream error ("Unsupported state or unable to authenticate data").
 */
export function decryptStream(file, passphrase) {
  const size = fs.statSync(file).size;
  if (size < HEADER + TAG) throw new Error('Not a Loopar encrypted backup (file too small).');
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(HEADER);
  const tag = Buffer.alloc(TAG);
  try {
    fs.readSync(fd, head, 0, HEADER, 0);
    fs.readSync(fd, tag, 0, TAG, size - TAG);
  } finally {
    fs.closeSync(fd);
  }
  if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Not a Loopar encrypted backup.');
  if (head[MAGIC.length] !== VERSION) throw new Error(`Unsupported backup encryption version ${head[MAGIC.length]}.`);
  const salt = head.subarray(MAGIC.length + 1, MAGIC.length + 17);
  const iv = head.subarray(MAGIC.length + 17, HEADER);
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
  decipher.setAuthTag(tag);

  const input = fs.createReadStream(file, { start: HEADER, end: size - TAG - 1 });
  const wrap = new Transform({
    transform(chunk, _enc, cb) {
      try { cb(null, decipher.update(chunk)); } catch (e) { cb(new Error('Wrong passphrase or damaged backup.', { cause: e })); }
    },
    flush(cb) {
      try { cb(null, decipher.final()); } catch (e) { cb(new Error('Wrong passphrase or damaged backup.', { cause: e })); }
    },
  });
  input.on('error', (e) => wrap.destroy(e));
  return input.pipe(wrap);
}

/** Check a passphrase against an encrypted backup without extracting it. */
export async function verifyPassphrase(file, passphrase) {
  const { Writable } = await import('node:stream');
  await pipeline(decryptStream(file, passphrase), new Writable({ write(_c, _e, cb) { cb(); } }));
  return true;
}
