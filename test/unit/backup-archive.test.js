import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import * as tar from "tar";
import { extractBackup } from "../../packages/loopar/core/backup/engine.js";
import { checkedDdl } from "../../packages/loopar/core/backup/database.js";

/** Archives that didn't come from this server: what extraction lets through. */
let dir;
before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "loopar-bkarch-")); });
after(() => fs.rmSync(dir, { recursive: true, force: true }));

async function archive(name, { manifest = {}, link } = {}) {
  const src = path.join(dir, `${name}-src`);
  fs.mkdirSync(path.join(src, "database"), { recursive: true });
  fs.mkdirSync(path.join(src, "site"), { recursive: true });
  fs.writeFileSync(path.join(src, "database", "database.sqlite"), "db");
  fs.writeFileSync(path.join(src, "site", "config.json"), "{}");
  if (link) fs.symlinkSync(link, path.join(src, "site", "uploads"));
  const sha = crypto.createHash("sha256").update("db").digest("hex");
  fs.writeFileSync(path.join(src, "manifest.json"), JSON.stringify({
    format: "loopar-backup", version: 1, tenant: "x",
    database: { dialect: "sqlite", file: "database/database.sqlite", sha256: sha },
    ...manifest,
  }));
  const file = path.join(dir, `${name}.tar.gz`);
  await tar.c({ gzip: true, cwd: src, file, portable: true }, ["manifest.json", "database", "site"]);
  return file;
}

test("links in an archive are dropped on extraction", async () => {
  const out = path.join(dir, "out-link");
  await extractBackup(await archive("link", { link: ".." }), null, out);
  assert.ok(fs.existsSync(path.join(out, "site", "config.json")));
  assert.ok(!fs.existsSync(path.join(out, "site", "uploads")), "the symlink was not extracted");
});

test("the manifest can't point the database file anywhere else", async () => {
  const sha = crypto.createHash("sha256").update("{}").digest("hex");
  const file = await archive("evil", { manifest: { database: { dialect: "sqlite", file: "../../../sites/victim/theme.css", sha256: sha } } });
  await assert.rejects(extractBackup(file, null, path.join(dir, "out-evil")), /manifest is not valid/);
});

test("MySQL dumps: only a plain CREATE TABLE of the table itself", () => {
  const ok = { table: "Users", ddl: "CREATE TABLE `Users` (\n  `id` int NOT NULL,\n  `select` varchar(10) DEFAULT 'a;SELECT 1'\n) ENGINE=InnoDB" };
  assert.equal(checkedDdl(ok), ok.ddl);
  for (const rec of [
    { table: "Users", ddl: "DROP DATABASE other" },
    { table: "Users", ddl: "CREATE TABLE `Users` (id int) SELECT * FROM other.secrets" },
    { table: "Users", ddl: "CREATE TABLE `Users` (a int, FOREIGN KEY (a) REFERENCES `other`.`t` (id))" },
    { table: "other.Users", ddl: "CREATE TABLE `other.Users` (a int)" },
    { table: "Users", ddl: "CREATE TABLE `Users` (a int) DATA DIRECTORY = '/tmp'" },
  ]) assert.throws(() => checkedDdl(rec), /not valid/, rec.ddl);
});
