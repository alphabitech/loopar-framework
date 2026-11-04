import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loopar, getOrCreateTenantInstance, getTenantInstance, evictTenantInstance } from "loopar";
import {
  createBackup, listLocalBackups, restoreBackup, inspectBackup, readSettingsBare,
  startRestoreJob, backupJob, isRestoring, safetySnapshot,
} from "../../packages/loopar/core/backup/index.js";
import { bootTestTenant } from "../support/tenant.js";

/**
 * Backups of a real tenant: settings stored with encrypted secrets, an
 * encrypted archive with its sidecar, restore in place through the core's
 * background job (gate, unplug, re-init) and restore as a new tenant.
 */
const root = process.cwd();
const SERVICE = path.join(root, "apps", "loopar", "modules", "backup", "backup-service.js");
let t, service;
const newTenant = `lpt-restored-${process.pid}`;

before(async () => {
  t = await bootTestTenant();
  service = await import(SERVICE);
});
after(async () => {
  evictTenantInstance(newTenant);
  fs.rmSync(path.join(root, "sites", newTenant), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.rmSync(path.join(root, "backups", newTenant), { recursive: true, force: true });
  await t?.teardown();
});

const settingValue = (field) => loopar.db.knex("Document Single Values").where({ document: "Backup Settings", field }).first();

test("Backup Settings is installed; secrets are stored encrypted and read back outside the core", async () => {
  await t.run(async () => {
    assert.ok(loopar.getRef("Backup Settings"), "Backup Settings entity ref");
    assert.ok(loopar.getRef("Backups"), "Backups page ref");
    await service.saveSettingsFields({ encrypt: 1, passphrase: "s3cret-pass", s3_prefix: "before" });
    const raw = await settingValue("passphrase");
    assert.ok(raw?.value && !raw.value.includes("s3cret-pass"), "passphrase is not stored in clear");
    assert.equal((await service.backupSettings()).passphrase, "s3cret-pass");
  });
  const bare = await readSettingsBare(root, t.name);
  assert.equal(bare.passphrase, "s3cret-pass");
  assert.equal(bare.s3_prefix, "before");
});

let file;
test("an encrypted local backup: archive + sidecar, listed, inspectable only with the passphrase", async () => {
  const settings = await readSettingsBare(root, t.name);
  const result = await createBackup({ root, tenant: t.name, kind: "manual", settings });
  file = result.file;
  assert.ok(result.encrypted);
  assert.match(file, /__manual\.tar\.gz\.enc$/);
  const dir = path.join(root, "backups", t.name);
  assert.ok(fs.existsSync(path.join(dir, file)) && fs.existsSync(path.join(dir, `${file}.json`)));
  assert.deepEqual(listLocalBackups(root, t.name).map((b) => b.file), [file]);

  const manifest = await inspectBackup({ root, file: path.join(dir, file), passphrase: "s3cret-pass" });
  assert.equal(manifest.tenant, t.name);
  assert.equal(manifest.database.dialect, "sqlite");
  await assert.rejects(inspectBackup({ root, file: path.join(dir, file), passphrase: "wrong" }), /Wrong passphrase/);
});

test("restore in place (core job): requests are gated, the tenant re-initializes with the backup's data", async () => {
  await t.run(() => service.saveSettingsFields({ s3_prefix: "after" }));
  const settings = await readSettingsBare(root, t.name);
  assert.equal(settings.s3_prefix, "after");

  await t.run(async () => {
    startRestoreJob({ root, tenant: t.name, file, settings });
    assert.throws(() => startRestoreJob({ root, tenant: t.name, file, settings }), /already running/);
  });
  let sawGate = false;
  for (let i = 0; i < 300 && !backupJob(t.name)?.finishedAt; i++) {
    sawGate ||= isRestoring(t.name);
    await new Promise((r) => setTimeout(r, 50));
  }
  const job = backupJob(t.name);
  assert.equal(job.error, null);
  assert.equal(job.ok, true);
  assert.ok(sawGate, "the tenant was gated during the swap");
  assert.ok(!isRestoring(t.name), "gate released");
  assert.ok(!getTenantInstance(t.name), "the old instance was unplugged");

  const cfg = JSON.parse(fs.readFileSync(path.join(root, "sites", t.name, "config.json"), "utf8"));
  assert.ok(cfg.restoredAt, "config.json carries restoredAt");

  await getOrCreateTenantInstance(t.name);
  await t.run(async () => {
    assert.equal((await settingValue("s3_prefix")).value, "before", "data is the backup's");
    assert.equal((await service.backupSettings()).passphrase, "s3cret-pass", "secrets still decrypt (same key)");
  });
  const kinds = listLocalBackups(root, t.name).map((b) => b.kind).sort();
  assert.deepEqual(kinds, ["manual", "pre-restore"], "a safety snapshot was taken first");
});

test("restore as a new tenant: suspended, own domain, the backup's data", async () => {
  await restoreBackup({ root, tenant: t.name, file, passphrase: "s3cret-pass", mode: "new", target: newTenant });
  const cfg = JSON.parse(fs.readFileSync(path.join(root, "sites", newTenant, "config.json"), "utf8"));
  assert.equal(cfg.status, "suspended");
  assert.equal(cfg.domain, `${newTenant}.localhost`);
  assert.ok(fs.existsSync(path.join(root, "sites", newTenant, "database", `${newTenant}.sqlite`)));
  assert.equal((await readSettingsBare(root, newTenant)).s3_prefix, "before");
  await assert.rejects(
    restoreBackup({ root, tenant: t.name, file, passphrase: "s3cret-pass", mode: "new", target: newTenant }),
    /already exists/,
  );
});

test("safety snapshot before an update is taken once per window", async () => {
  const before = listLocalBackups(root, t.name).filter((b) => b.kind === "pre-update").length;
  const first = await safetySnapshot(t.name, "test", root);
  const second = await safetySnapshot(t.name, "test", root);
  assert.ok(first);
  assert.equal(second, first);
  const after = listLocalBackups(root, t.name).filter((b) => b.kind === "pre-update").length;
  assert.ok(after - before <= 1);
});
