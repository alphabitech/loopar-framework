import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { signV4 } from "../../packages/loopar/core/backup/destinations/s3.js";
import { WebdavDestination } from "../../packages/loopar/core/backup/destinations/webdav.js";
import { makeDestination } from "../../packages/loopar/core/backup/destinations/index.js";

test("S3 SigV4 matches AWS's documented example (GET Object)", () => {
  const h = signV4({
    method: "GET", url: "https://examplebucket.s3.amazonaws.com/test.txt", region: "us-east-1",
    accessKey: "AKIAIOSFODNN7EXAMPLE", secretKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    headers: { range: "bytes=0-9" }, payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    date: new Date("2013-05-24T00:00:00Z"),
  });
  assert.equal(
    h.authorization,
    "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
  );
});

test("makeDestination(): local means none; a remote one validates its settings", () => {
  assert.equal(makeDestination({ destination: "local" }), null);
  assert.throws(() => makeDestination({ destination: "s3" }), /s3_bucket/);
  assert.throws(() => makeDestination({ destination: "sftp", sftp_host: "h", sftp_username: "u" }), /password or a private key/);
  assert.throws(() => makeDestination({ destination: "gdrive", gdrive_client_id: "i", gdrive_client_secret: "s" }), /not connected/);
  assert.throws(() => makeDestination({ destination: "ftp" }), /Unknown backup destination/);
});

// A tiny WebDAV server: enough of PUT/GET/DELETE/MKCOL/PROPFIND for the driver.
let server, base, root;
before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "loopar-dav-"));
  server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Basic ${Buffer.from("u:p").toString("base64")}`) { res.writeHead(401).end(); return; }
    const p = path.join(root, decodeURIComponent(new URL(req.url, "http://x").pathname));
    const body = await new Promise((r) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => r(Buffer.concat(c))); });
    if (req.method === "MKCOL") { if (fs.existsSync(p)) return res.writeHead(405).end(); fs.mkdirSync(p, { recursive: true }); return res.writeHead(201).end(); }
    if (req.method === "PUT") { fs.writeFileSync(p, body); return res.writeHead(201).end(); }
    if (req.method === "GET") { if (!fs.existsSync(p)) return res.writeHead(404).end(); return res.writeHead(200).end(fs.readFileSync(p)); }
    if (req.method === "DELETE") { if (!fs.existsSync(p)) return res.writeHead(404).end(); fs.rmSync(p); return res.writeHead(204).end(); }
    if (req.method === "PROPFIND") {
      if (!fs.existsSync(p)) return res.writeHead(404).end();
      const entries = fs.readdirSync(p).map((f) => {
        const st = fs.statSync(path.join(p, f));
        return `<d:response><d:href>${req.url.replace(/\/$/, "")}/${encodeURIComponent(f)}</d:href><d:propstat><d:prop>${st.isDirectory() ? "<d:resourcetype><d:collection/></d:resourcetype>" : `<d:getcontentlength>${st.size}</d:getcontentlength>`}<d:getlastmodified>${st.mtime.toUTCString()}</d:getlastmodified></d:prop></d:propstat></d:response>`;
      });
      return res.writeHead(207, { "content-type": "application/xml" }).end(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>${req.url}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>${entries.join("")}</d:multistatus>`);
    }
    res.writeHead(405).end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}/backups`;
});
after(() => { server.close(); fs.rmSync(root, { recursive: true, force: true }); });

test("WebDAV: upload, list, download, remove", async () => {
  const d = new WebdavDestination({ webdav_url: base, webdav_username: "u", webdav_password: "p" });
  const src = path.join(root, "src.bin");
  fs.writeFileSync(src, Buffer.alloc(70_000, 7));
  const name = "dev__20261103T120000Z__manual.tar.gz";
  await d.upload(src, "dev", name);
  assert.deepEqual((await d.list("dev")).map((f) => [f.file, f.size]), [[name, 70_000]]);
  const out = path.join(root, "out.bin");
  await d.download("dev", name, out);
  assert.deepEqual(fs.readFileSync(out), fs.readFileSync(src));
  await d.remove("dev", name);
  assert.deepEqual(await d.list("dev"), []);
  await assert.rejects(new WebdavDestination({ webdav_url: base, webdav_username: "u", webdav_password: "bad" }).upload(src, "dev", name), /HTTP 401/);
});

test("destination URLs: plain http(s) only, never a metadata service", async () => {
  const { checkBaseUrl } = await import("../../packages/loopar/core/backup/destinations/http.js");
  assert.equal(checkBaseUrl("https://dav.example.com/files/", "x"), "https://dav.example.com/files");
  for (const bad of ["http://169.254.169.254/latest/meta-data/?x=", "https://h/p?x", "https://u:p@h/p", "ftp://h/p", "nope"]) {
    assert.throws(() => checkBaseUrl(bad, "x"), /x:/, bad);
  }
  assert.throws(() => new WebdavDestination({ webdav_url: "http://169.254.169.254/x" }), /not allowed/);
  assert.throws(() => makeDestination({ destination: "s3", s3_bucket: "b/../x?", s3_access_key: "a", s3_secret_key: "s" }), /bucket/);
});

test("SFTP private keys only come from config/backup-keys/", async () => {
  const { keyFile, KEYS_DIR } = await import("../../packages/loopar/core/backup/destinations/sftp.js");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loopar-keys-"));
  try {
    fs.mkdirSync(path.join(tmp, KEYS_DIR), { recursive: true });
    fs.writeFileSync(path.join(tmp, KEYS_DIR, "backup_ed25519"), "key");
    fs.symlinkSync("/etc/hosts", path.join(tmp, KEYS_DIR, "escape"));
    assert.equal(keyFile("backup_ed25519", tmp), fs.realpathSync(path.join(tmp, KEYS_DIR, "backup_ed25519")));
    for (const bad of ["/etc/passwd", "../config.json", "sub/key", ".hidden", "escape", "missing"]) {
      assert.throws(() => keyFile(bad, tmp), /SFTP destination/, bad);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
