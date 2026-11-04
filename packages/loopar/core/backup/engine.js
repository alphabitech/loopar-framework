'use strict';

/**
 * Backups of a tenant: one archive with its database, its site folder
 * (config.json — whose secretKey decrypts the tenant's stored secrets —,
 * uploads, themes) and a manifest. Optionally encrypted, copied to a remote
 * destination, pruned by retention, and restorable in place or as a new
 * tenant.
 *
 * Framework-free on purpose (the CLI and the TUI use it when a tenant won't
 * boot). The core adds the request gate and the tenant re-init through the
 * `beforeSwap` / `afterSwap` hooks of restoreBackup (see core-ops.js).
 *
 *   backups/<tenant>/<tenant>__<YYYYMMDDTHHMMSSZ>__<kind>.tar.gz[.enc]
 *   backups/<tenant>/<same>.json        sidecar: manifest + size + sha256
 *
 * Archive layout: manifest.json · database/<dump> · site/<sites/<tenant> minus database/ and sessions/>
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';
import { encryptFile, decryptStream, isEncryptedFile } from './crypto.js';
import { backupsToDelete } from './retention.js';
import { dumpDatabase, restoreDatabase, readDbConfig, dialectOf, siteDir, appVersions } from './database.js';
import { readSettingsBare } from './settings.js';
import { makeDestination } from './destinations/index.js';

export const BACKUP_FORMAT = 'loopar-backup';
export const BACKUP_VERSION = 1;
export const BACKUP_KINDS = ['manual', 'scheduled', 'pre-update', 'pre-restore', 'uploaded'];
const NAME_RE = /^([\w.-]+?)__(\d{8}T\d{6}Z)__([a-z-]+)\.tar\.gz(\.enc)?$/;
const EXCLUDED_DIRS = new Set(['database', 'sessions']);

const stampOf = (d) => d.toISOString().replace(/[-:]|\.\d{3}/g, '');
const dateOfStamp = (s) => new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`);

export function backupsRoot(root) {
  return path.join(root, 'backups');
}

export function backupsDir(root, tenant) {
  return path.join(backupsRoot(root), tenant);
}

export function backupFileName(tenant, kind, date = new Date(), encrypted = false) {
  return `${tenant}__${stampOf(date)}__${kind}.tar.gz${encrypted ? '.enc' : ''}`;
}

/** { tenant, date, kind, encrypted } of a backup file name, or null. */
export function parseBackupName(file) {
  const m = NAME_RE.exec(String(file || ''));
  if (!m) return null;
  return { tenant: m[1], date: dateOfStamp(m[2]), kind: m[3], encrypted: !!m[4] };
}

const safeName = (file) => {
  if (!parseBackupName(file) || file.includes('/') || file.includes('\\')) throw Object.assign(new Error(`Not a backup file name: ${file}`), { status: 400 });
  return file;
};

async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

function frameworkInfo(root) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    return { name: pkg.name, version: pkg.version };
  } catch {
    return { name: 'loopar', version: null };
  }
}

/** rm -rf that tolerates files still being released (SQLite journals, slow mounts). */
const rmrf = (p) => fs.promises.rm(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});

async function workDir(root, label) {
  const dir = path.join(backupsRoot(root), '.work', `${label}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  await fs.promises.mkdir(dir, { recursive: true });
  return dir;
}

// ─── Lock (one backup/restore per tenant, across processes) ─────────────────

async function withLock(root, tenant, fn) {
  const dir = backupsDir(root, tenant);
  await fs.promises.mkdir(dir, { recursive: true });
  const lock = path.join(dir, '.lock');
  const take = () => fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
  try {
    take();
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const pid = Number(fs.readFileSync(lock, 'utf8')) || 0;
    let alive = false;
    try { if (pid) { process.kill(pid, 0); alive = true; } } catch { alive = false; }
    if (alive && pid !== process.pid) throw Object.assign(new Error(`A backup or restore of "${tenant}" is already running (pid ${pid}).`), { status: 409 });
    if (pid === process.pid) throw Object.assign(new Error(`A backup or restore of "${tenant}" is already running.`), { status: 409 });
    // Two processes may find the same stale lock: only the one whose rename wins clears it.
    const stale = `${lock}.${process.pid}.${Date.now()}`;
    try { fs.renameSync(lock, stale); fs.rmSync(stale, { force: true }); } catch { /* the other one did */ }
    take();
  }
  try {
    return await fn();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

// Checksums of the archives this server made for the tenant. A server
// database (MySQL/PostgreSQL) is only restored from the desk out of one of
// these: a dump replays SQL with the server's DB credentials, so an archive
// from anywhere else (an upload, a file planted on the remote) goes through
// the operator's CLI.
const LEDGER = '.made';

/** Was this archive made by this server (for this tenant)? */
export async function madeHere(root, tenant, archive) {
  let lines;
  try { lines = (await fs.promises.readFile(path.join(backupsDir(root, tenant), LEDGER), 'utf8')).split('\n'); } catch { return false; }
  const sum = await sha256File(archive);
  return lines.includes(sum);
}

// ─── Create ───────────────────────────────────────────────────────────────────

/**
 * Back up a tenant.
 * @param {object} o
 * @param {string} o.tenant
 * @param {string} [o.kind='manual']    manual | scheduled | pre-update | pre-restore
 * @param {object} [o.settings]         Backup Settings (read from the tenant when omitted)
 * @param {boolean} [o.upload=true]     copy to the remote destination
 * @param {boolean} [o.prune=true]      apply retention afterwards
 * @param {string} [o.note]             free text kept in the manifest
 * @param {Function} [o.onStep]         (step) progress callback
 * @returns {Promise<{ file, path, size, sha256, encrypted, manifest, remote: { destination, ok, error }, pruned }>}
 */
export async function createBackup({ root = process.cwd(), tenant, kind = 'manual', settings, upload = true, prune = true, note = null, onStep = () => {}, lock = true } = {}) {
  if (!tenant || !fs.existsSync(siteDir(root, tenant))) throw Object.assign(new Error(`Tenant "${tenant}" not found.`), { status: 404 });
  if (!BACKUP_KINDS.includes(kind)) throw new Error(`Unknown backup kind "${kind}".`);
  const run = async () => {
    settings ??= await readSettingsBare(root, tenant);
    const destination = upload ? makeDestination(settings) : null;
    const encrypt = !!(settings.encrypt && settings.passphrase);
    if (destination && settings.encrypt && !settings.passphrase) {
      throw new Error('Set an encryption passphrase in Backup Settings before sending backups to a remote destination (or turn encryption off).');
    }

    const work = await workDir(root, `${tenant}-backup`);
    try {
      onStep('database');
      await fs.promises.mkdir(path.join(work, 'database'));
      const db = await dumpDatabase(root, tenant, path.join(work, 'database'));
      const dbPath = path.join(work, 'database', db.file);

      const date = new Date();
      const manifest = {
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        tenant,
        kind,
        note,
        createdAt: date.toISOString(),
        host: os.hostname(),
        framework: frameworkInfo(root),
        apps: await appVersions(root, tenant),
        database: { dialect: db.dialect, file: `database/${db.file}`, size: fs.statSync(dbPath).size, sha256: await sha256File(dbPath) },
        files: { included: !!settings.include_files },
      };
      await fs.promises.writeFile(path.join(work, 'manifest.json'), JSON.stringify(manifest, null, 2));

      onStep('archive');
      const entries = ['manifest.json', 'database'];
      if (settings.include_files) {
        await fs.promises.symlink(siteDir(root, tenant), path.join(work, 'site'), 'dir');
        entries.push('site');
      } else {
        // Still keep config.json: without its secretKey the stored secrets are lost.
        await fs.promises.mkdir(path.join(work, 'site', 'config'), { recursive: true });
        for (const f of ['config.json', path.join('config', 'db.config.json')]) {
          const src = path.join(siteDir(root, tenant), f);
          if (fs.existsSync(src)) await fs.promises.copyFile(src, path.join(work, 'site', f));
        }
        entries.push('site');
      }
      const plain = path.join(work, 'archive.tar.gz');
      await tar.c({
        gzip: true, cwd: work, file: plain, portable: true, follow: true,
        filter: (p) => {
          const parts = p.replace(/^\.\//, '').split('/');
          if (parts[0] === 'site' && EXCLUDED_DIRS.has(parts[1])) return false;
          return !/\.sqlite-(wal|shm|journal)$/.test(p);
        },
      }, entries);

      const dir = backupsDir(root, tenant);
      await fs.promises.mkdir(dir, { recursive: true });
      const file = backupFileName(tenant, kind, date, encrypt);
      const final = path.join(dir, file);
      if (encrypt) {
        onStep('encrypt');
        await encryptFile(plain, `${final}.part`, settings.passphrase);
      } else {
        await fs.promises.copyFile(plain, `${final}.part`);
      }
      await fs.promises.rename(`${final}.part`, final);

      const size = fs.statSync(final).size;
      const sha256 = await sha256File(final);
      const sidecar = { ...manifest, file, size, sha256, encrypted: encrypt };
      await fs.promises.writeFile(`${final}.json`, JSON.stringify(sidecar, null, 2));
      await fs.promises.appendFile(path.join(dir, LEDGER), `${sha256}\n`);

      const remote = { destination: destination?.name ?? null, ok: null, error: null };
      if (destination) {
        onStep('upload');
        try {
          await destination.upload(final, tenant, file);
          await destination.upload(`${final}.json`, tenant, `${file}.json`);
          remote.ok = true;
        } catch (e) {
          remote.ok = false;
          remote.error = e.message;
        }
      }

      let pruned = [];
      if (prune) {
        onStep('prune');
        pruned = await pruneBackups({ root, tenant, settings, destination });
      }
      return { file, path: final, size, sha256, encrypted: encrypt, manifest: sidecar, remote, pruned };
    } finally {
      await rmrf(work);
    }
  };
  return lock ? await withLock(root, tenant, run) : await run();
}

// ─── List / delete / prune ────────────────────────────────────────────────────

function readSidecar(file) {
  try { return JSON.parse(fs.readFileSync(`${file}.json`, 'utf8')); } catch { return null; }
}

/** Local backups of a tenant, newest first. */
export function listLocalBackups(root, tenant) {
  const dir = backupsDir(root, tenant);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names
    .filter((n) => parseBackupName(n))
    .map((n) => {
      const p = path.join(dir, n);
      const meta = parseBackupName(n);
      const side = readSidecar(p);
      return { file: n, ...meta, size: fs.statSync(p).size, sha256: side?.sha256 ?? null, manifest: side };
    })
    .sort((a, b) => b.date - a.date);
}

/**
 * Local and remote backups of a tenant, merged by file name, newest first.
 * @returns {Promise<{ rows: Array, destination: string|null, remoteError: string|null }>}
 */
export async function listBackups({ root = process.cwd(), tenant, settings, remote = true } = {}) {
  settings ??= await readSettingsBare(root, tenant);
  const rows = new Map(listLocalBackups(root, tenant).map((b) => [b.file, { ...b, local: true, remote: false }]));
  let destination = null;
  let remoteError = null;
  if (remote) {
    try {
      destination = makeDestination(settings);
      if (destination) {
        for (const f of await destination.list(tenant)) {
          const meta = parseBackupName(f.file);
          if (!meta || meta.tenant !== tenant) continue;
          const row = rows.get(f.file);
          if (row) row.remote = true;
          else rows.set(f.file, { file: f.file, ...meta, size: f.size, sha256: null, manifest: null, local: false, remote: true });
        }
      }
    } catch (e) {
      remoteError = e.message;
    }
  }
  return { rows: [...rows.values()].sort((a, b) => b.date - a.date), destination: destination?.name ?? null, remoteError };
}

export async function deleteBackup({ root = process.cwd(), tenant, file, settings, where = 'both' } = {}) {
  safeName(file);
  if (where !== 'remote') {
    const p = path.join(backupsDir(root, tenant), file);
    await fs.promises.rm(p, { force: true });
    await fs.promises.rm(`${p}.json`, { force: true });
  }
  if (where !== 'local') {
    settings ??= await readSettingsBare(root, tenant);
    const destination = makeDestination(settings);
    if (destination) {
      await destination.remove(tenant, file);
      await destination.remove(tenant, `${file}.json`).catch(() => {});
    }
  }
}

/** Apply retention to local and remote copies. @returns {string[]} deleted file names */
export async function pruneBackups({ root = process.cwd(), tenant, settings, destination } = {}) {
  settings ??= await readSettingsBare(root, tenant);
  const retention = { daily: settings.keep_daily, weekly: settings.keep_weekly, monthly: settings.keep_monthly };
  const removed = [];
  const local = listLocalBackups(root, tenant).map((b) => ({ name: b.file, kind: b.kind, date: b.date }));
  for (const name of backupsToDelete(local, retention)) {
    await deleteBackup({ root, tenant, file: name, where: 'local' });
    removed.push(name);
  }
  destination ??= makeDestination(settings);
  if (destination) {
    try {
      const remote = (await destination.list(tenant))
        .map((f) => ({ name: f.file, ...parseBackupName(f.file) }))
        .filter((b) => b.kind);
      for (const name of backupsToDelete(remote, retention)) {
        await destination.remove(tenant, name);
        await destination.remove(tenant, `${name}.json`).catch(() => {});
        if (!removed.includes(name)) removed.push(name);
      }
    } catch {
      // A remote that can't be listed now is pruned on the next run.
    }
  }
  return removed;
}

/** Local path of a backup, downloading it from the destination when it's only remote. */
export async function fetchBackup({ root = process.cwd(), tenant, file, settings } = {}) {
  safeName(file);
  const p = path.join(backupsDir(root, tenant), file);
  if (fs.existsSync(p)) return p;
  settings ??= await readSettingsBare(root, tenant);
  const destination = makeDestination(settings);
  if (!destination) throw Object.assign(new Error(`Backup ${file} not found.`), { status: 404 });
  await fs.promises.mkdir(path.dirname(p), { recursive: true });
  await destination.download(tenant, file, `${p}.part`);
  // Whatever answered must at least look like a backup (gzip or our encrypted format).
  const head = Buffer.alloc(8);
  const fd = fs.openSync(`${p}.part`, 'r');
  try { fs.readSync(fd, head, 0, 8, 0); } finally { fs.closeSync(fd); }
  if (!(head[0] === 0x1f && head[1] === 0x8b) && !isEncryptedFile(`${p}.part`)) {
    await fs.promises.rm(`${p}.part`, { force: true });
    throw Object.assign(new Error(`The destination did not return a backup for ${file}.`), { status: 502 });
  }
  await fs.promises.rename(`${p}.part`, p);
  await destination.download(tenant, `${file}.json`, `${p}.json`).catch(() => {});
  return p;
}

/**
 * Store an archive uploaded by a user (another server, an older download)
 * under this tenant's backups. Its content is checked on restore.
 */
const MAX_UPLOADED = 10;

export async function importBackup({ root = process.cwd(), tenant, source, originalName = '' } = {}) {
  const head = Buffer.alloc(8);
  const fd = fs.openSync(source, 'r');
  try { fs.readSync(fd, head, 0, 8, 0); } finally { fs.closeSync(fd); }
  const encrypted = isEncryptedFile(source);
  if (!encrypted && !(head[0] === 0x1f && head[1] === 0x8b)) throw Object.assign(new Error('Not a Loopar backup (expected a .tar.gz or .tar.gz.enc archive).'), { status: 400 });
  const file = backupFileName(tenant, 'uploaded', new Date(), encrypted);
  const dir = backupsDir(root, tenant);
  await fs.promises.mkdir(dir, { recursive: true });
  const kept = listLocalBackups(root, tenant).filter((b) => b.kind === 'uploaded');
  if (kept.length >= MAX_UPLOADED) {
    throw Object.assign(new Error(`There are already ${MAX_UPLOADED} uploaded backups: delete one first.`), { status: 409 });
  }
  try {
    await fs.promises.copyFile(source, path.join(dir, file), fs.constants.COPYFILE_EXCL);
  } catch (e) {
    if (e.code === 'EEXIST') throw Object.assign(new Error('Another upload just landed: try again.'), { status: 409 });
    throw e;
  }
  void originalName;
  return { file };
}

// ─── Restore ──────────────────────────────────────────────────────────────────

const MAX_EXPANSION = 50;
const MIN_EXTRACT_LIMIT = 1024 ** 3;
const DIALECTS = ['sqlite', 'mysql', 'postgres'];

/** Extract an archive (decrypting it when needed) and check its manifest and database checksum. */
export async function extractBackup(file, passphrase, destDir) {
  await fs.promises.mkdir(destDir, { recursive: true });
  const encrypted = isEncryptedFile(file);
  if (encrypted && !passphrase) throw Object.assign(new Error('This backup is encrypted: the passphrase is required.'), { status: 400 });
  const input = encrypted ? decryptStream(file, passphrase) : fs.createReadStream(file);
  // Decompression bomb guard: a site compresses far less than this.
  const limit = Math.max(fs.statSync(file).size * MAX_EXPANSION, MIN_EXTRACT_LIMIT);
  let total = 0;
  const cap = new Transform({
    transform(chunk, _enc, cb) {
      total += chunk.length;
      cb(total > limit ? Object.assign(new Error('The backup expands to more than expected: refusing to extract it.'), { status: 400, bomb: true }) : null, chunk);
    },
  });
  // Only plain files and folders: no links (they could point out of the site once it's swapped in).
  const filter = (_p, entry) => entry.type === 'File' || entry.type === 'Directory' || entry.type === 'OldFile';
  try {
    await pipeline(input, zlib.createGunzip(), cap, tar.x({ cwd: destDir, strict: true, preservePaths: false, filter }));
  } catch (e) {
    if (e.bomb) throw e;
    // With a wrong key the "plaintext" is noise: tar fails before GCM can say why.
    throw Object.assign(new Error(encrypted ? 'Wrong passphrase, or the backup is damaged.' : `The backup can't be read: ${e.message}`, { cause: e }), { status: 400 });
  }
  let manifest;
  try { manifest = JSON.parse(await fs.promises.readFile(path.join(destDir, 'manifest.json'), 'utf8')); } catch {
    throw new Error('The archive has no manifest: it is not a Loopar backup.');
  }
  if (manifest.format !== BACKUP_FORMAT) throw new Error('The archive is not a Loopar backup.');
  if (manifest.version > BACKUP_VERSION) throw new Error(`The backup was made by a newer Loopar (format v${manifest.version}).`);
  if (!DIALECTS.includes(manifest.database?.dialect) || !/^database\/database\.(sqlite|mysql\.ndjson|pgdump)$/.test(String(manifest.database?.file))) {
    throw new Error('The backup manifest is not valid.');
  }
  const dbFile = path.join(destDir, manifest.database.file);
  if (!fs.existsSync(dbFile) || (await sha256File(dbFile)) !== manifest.database.sha256) {
    throw new Error('The database in the backup is damaged (checksum mismatch).');
  }
  return manifest;
}

/** Read only the manifest of a backup (decrypts and extracts to a temp dir). */
export async function inspectBackup({ root = process.cwd(), file, passphrase }) {
  const work = await workDir(root, 'inspect');
  try {
    return await extractBackup(file, passphrase, work);
  } finally {
    await rmrf(work);
  }
}

const CONFIG_FROM_BACKUP = ['secretKey', 'jwtSecret'];

const readJson = (p, fallback = {}) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } };

/**
 * Restore a backup.
 *
 *   mode 'replace' — over the same tenant (in place). Routing (domain, status,
 *                    websites) and the DB connection stay as they are now;
 *                    everything else — data, files, secretKey — comes from
 *                    the backup. A `pre-restore` snapshot is taken first.
 *   mode 'new'     — as a new tenant `target` (SQLite only), turned Off.
 *
 * @param {object} o
 * @param {string} o.tenant          tenant the backup belongs to (its folder under backups/)
 * @param {string} o.file            backup file name
 * @param {string} [o.passphrase]    for encrypted backups (default: the tenant's settings)
 * @param {'replace'|'new'} [o.mode]
 * @param {string} [o.target]        new tenant name (mode 'new')
 * @param {Function} [o.beforeSwap]  async (target) — stop serving the tenant (core: gate + unplug)
 * @param {Function} [o.afterSwap]   async (target, ok) — serve again
 * @param {Function} [o.onStep]
 */
export async function restoreBackup({ root = process.cwd(), tenant, file, passphrase, settings, mode = 'replace', target, requireMadeHere = false, beforeSwap = async () => {}, afterSwap = async () => {}, onStep = () => {} } = {}) {
  target = mode === 'new' ? target : tenant;
  if (mode === 'new') {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(String(target || ''))) throw Object.assign(new Error('New tenant name: lowercase letters, numbers and dashes.'), { status: 400 });
    if (fs.existsSync(siteDir(root, target))) throw Object.assign(new Error(`Tenant "${target}" already exists.`), { status: 409 });
  } else if (!fs.existsSync(siteDir(root, tenant))) {
    throw Object.assign(new Error(`Tenant "${tenant}" not found.`), { status: 404 });
  }

  return await withLock(root, target, async () => {
    settings ??= await readSettingsBare(root, tenant);
    const archive = await fetchBackup({ root, tenant, file, settings });
    const work = await workDir(root, `${target}-restore`);
    let safety = null;
    try {
      onStep('verify');
      const manifest = await extractBackup(archive, passphrase || settings.passphrase, work);
      const dialect = manifest.database.dialect;
      if (requireMadeHere && dialect !== 'sqlite' && !(await madeHere(root, tenant, archive))) {
        throw Object.assign(new Error(`This ${dialect} backup was not made by this server: restore it with \`yarn backup restore\` on the server.`), { status: 400 });
      }
      const staged = path.join(work, 'site');
      await fs.promises.mkdir(path.join(staged, 'database'), { recursive: true });
      await fs.promises.mkdir(path.join(staged, 'config'), { recursive: true });

      if (mode === 'replace') {
        const current = dialectOf(readDbConfig(root, target));
        if (current !== dialect) throw new Error(`The backup holds a ${dialect} database and "${target}" uses ${current}.`);
        onStep('safety');
        safety = await createBackup({ root, tenant: target, kind: 'pre-restore', settings, upload: false, prune: true, lock: false, note: `before restoring ${file}` });
      } else if (dialect !== 'sqlite') {
        throw new Error('Restoring as a new tenant supports SQLite tenants only.');
      }

      // config.json: the backup's (secretKey, jwtSecret…) with this server's routing.
      const backupCfg = readJson(path.join(staged, 'config.json'));
      const currentCfg = mode === 'replace' ? readJson(path.join(siteDir(root, target), 'config.json')) : {};
      const restoredAt = new Date().toISOString();
      // Only the tenant's own secrets come from the archive; routing stays this server's.
      const secrets = {};
      for (const k of CONFIG_FROM_BACKUP) if (typeof backupCfg[k] === 'string' && backupCfg[k]) secrets[k] = backupCfg[k];
      const cfg = mode === 'replace'
        ? { ...currentCfg, ...secrets, restoredAt }
        : { ...secrets, domain: `${target}.localhost`, status: 'suspended', sites: {}, restoredAt };
      delete cfg.installToken;
      await fs.promises.writeFile(path.join(staged, 'config.json'), JSON.stringify(cfg, null, 2));

      // The DB connection is this server's in place; a new tenant keeps the backup's (SQLite).
      if (mode === 'replace') {
        const dbCfg = path.join(siteDir(root, target), 'config', 'db.config.json');
        if (fs.existsSync(dbCfg)) await fs.promises.copyFile(dbCfg, path.join(staged, 'config', 'db.config.json'));
      }
      if (dialect === 'sqlite') {
        await fs.promises.rename(path.join(work, manifest.database.file), path.join(staged, 'database', `${target}.sqlite`));
      }

      onStep('swap');
      await beforeSwap(target);
      let ok = false;
      const previous = path.join(work, 'previous');
      try {
        if (mode === 'replace') await fs.promises.rename(siteDir(root, target), previous);
        try {
          await fs.promises.rename(staged, siteDir(root, target));
          if (dialect !== 'sqlite') {
            onStep('database');
            await restoreDatabase(root, target, dialect, path.join(work, manifest.database.file));
          }
          // A backup without files only replaced data and config: keep this
          // server's uploads, themes… (everything but what was restored).
          if (mode === 'replace' && !manifest.files?.included) {
            for (const entry of await fs.promises.readdir(previous)) {
              if (['config.json', 'config', 'database', 'sessions'].includes(entry)) continue;
              await fs.promises.rename(path.join(previous, entry), path.join(siteDir(root, target), entry)).catch(() => {});
            }
          }
          ok = true;
        } catch (e) {
          // Put the previous files back; a server database is rolled back from the safety snapshot.
          if (fs.existsSync(siteDir(root, target))) await fs.promises.rename(siteDir(root, target), path.join(work, 'failed'));
          if (mode === 'replace') await fs.promises.rename(previous, siteDir(root, target));
          if (dialect !== 'sqlite' && safety) {
            const back = path.join(work, 'rollback');
            const m = await extractBackup(safety.path, settings.passphrase, back);
            await restoreDatabase(root, target, dialect, path.join(back, m.database.file)).catch(() => {});
          }
          throw e;
        }
      } finally {
        await afterSwap(target, ok);
      }
      return { tenant: target, file, mode, manifest, safety: safety?.file ?? null, restoredAt };
    } finally {
      await rmrf(work);
    }
  });
}
