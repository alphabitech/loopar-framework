import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { pipeline } from "node:stream/promises";
import { encryptFile, decryptStream, isEncryptedFile, verifyPassphrase } from "../../packages/loopar/core/backup/crypto.js";

let dir;
before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "loopar-bkcrypto-")); });
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

test("encrypt → decrypt round-trips a large file byte for byte", async () => {
  const plain = path.join(dir, "plain.bin");
  fs.writeFileSync(plain, crypto.randomBytes(2 * 1024 * 1024 + 123));
  const enc = path.join(dir, "plain.bin.enc");
  await encryptFile(plain, enc, "correct horse");
  assert.ok(isEncryptedFile(enc));
  assert.ok(!isEncryptedFile(plain));
  const out = path.join(dir, "out.bin");
  await pipeline(decryptStream(enc, "correct horse"), fs.createWriteStream(out));
  assert.equal(sha(out), sha(plain));
  assert.ok(await verifyPassphrase(enc, "correct horse"));
});

test("a wrong passphrase or a flipped byte is rejected", async () => {
  const plain = path.join(dir, "small.txt");
  fs.writeFileSync(plain, "hello backups");
  const enc = path.join(dir, "small.txt.enc");
  await encryptFile(plain, enc, "pw");
  await assert.rejects(verifyPassphrase(enc, "nope"), /Wrong passphrase|damaged/);
  const buf = fs.readFileSync(enc);
  buf[buf.length - 20] ^= 0xff;
  fs.writeFileSync(enc, buf);
  await assert.rejects(verifyPassphrase(enc, "pw"), /Wrong passphrase|damaged/);
});
