/**
 * Build step 3/3 — Activate the staged release.
 *
 *   1. Atomically swap `dist` → `build/releases/<tag>` via rename(2).
 *      Existing PM2 workers keep serving the OLD bundle until reload — their
 *      ESM module cache still holds the previous dist/server/entry-server.js.
 *      Static file lookups (main.html, client assets) flip instantly because
 *      they're resolved per request.
 *
 *   2. `pm2.reload` the core process.
 *      In cluster mode (exec_mode: 'cluster'), reload forks a fresh worker —
 *      which loads the new SSR bundle from scratch — waits for it to come
 *      online, then kills the old worker. New requests hit new code, no
 *      blank-screen window.
 *
 *   3. Prune old releases.
 *      Keep the last N timestamped releases so rollback is just
 *      `ln -sfn build/releases/<previous> dist && pm2 reload all`.
 */
import "loopar/bin/pm2-home.js";
import fs from 'fs';
import path from 'pathe';
import { promisify } from 'util';
import pm2 from 'pm2';
import { ROOT, RELEASES_DIR, readTag, clearTag } from './lib/release.js';

const CORE_PROCESS_NAME = 'loopar-core';

// Current + 2 previous: rollback targets AND the source of hashed chunks for
// tabs still running an older client (core/server/build-info.js).
const KEEP_RELEASES = 3;

const tag = readTag({ requiredBy: 'activate' });

const releaseTarget = `build/releases/${tag}`;      // relative — symlink stays portable
const distPath = path.join(ROOT, 'dist');
const tmpLink = path.join(ROOT, '.dist.swap');

// Clean any leftover from a prior interrupted run
try { fs.unlinkSync(tmpLink); } catch (_) { /* ignore */ }

fs.symlinkSync(releaseTarget, tmpLink, 'dir');

const existing = fs.lstatSync(distPath, { throwIfNoEntry: false });
if (existing && existing.isDirectory() && !existing.isSymbolicLink()) {
  // First migration from the old layout: dist/ is a real folder, not a
  // symlink. rename(2) cannot replace a non-empty directory with a symlink,
  // so we move the legacy dist aside first. After this run, dist is always
  // a symlink and future swaps are a single atomic rename.
  console.log('⚠️  Legacy dist/ detected (real directory). Moving aside…');
  fs.renameSync(distPath, path.join(RELEASES_DIR, `_legacy_${tag}`));
}

// Atomic on POSIX — replaces the existing symlink (or creates fresh) in a
// single syscall. No window where `dist` is missing.
fs.renameSync(tmpLink, distPath);
console.log(`🔗 dist → ${releaseTarget}`);

const pm2Connect = () => new Promise((res, rej) => pm2.connect(e => e ? rej(e) : res()));
const pm2Reload = promisify(pm2.reload.bind(pm2));
const pm2Describe = promisify(pm2.describe.bind(pm2));

await pm2Connect();
try {
  const desc = await pm2Describe(CORE_PROCESS_NAME).catch(() => []);
  const status = desc[0]?.pm2_env?.status;
  if (status === 'online') {
    // Cluster mode → zero-downtime reload; fork mode → in-place restart.
    await pm2Reload(CORE_PROCESS_NAME);
    console.log(`♻️  core (${CORE_PROCESS_NAME}) reloaded`);
  } else {
    console.log(`⏭  core (${status || 'stopped'}) — not online; start it with \`yarn start\``);
  }
} catch (err) {
  console.error(`❌ core reload failed: ${err.message || err}`);
} finally {
  pm2.disconnect();
}

const allReleases = fs.readdirSync(RELEASES_DIR)
  .filter(name => name !== tag && !name.startsWith('_legacy_'))
  .sort() // ISO timestamps sort chronologically
  .reverse(); // newest first

const toKeep = allReleases.slice(0, KEEP_RELEASES - 1); // newest N-1 prior + current = N total
const toPrune = allReleases.slice(KEEP_RELEASES - 1);

for (const old of toPrune) {
  fs.rmSync(path.join(RELEASES_DIR, old), { recursive: true, force: true });
  console.log(`🗑  pruned build/releases/${old}`);
}

if (toKeep.length > 0) {
  console.log(`\n   kept for rollback: ${toKeep.join(', ')}`);
}

clearTag();

console.log(`\n✅ Deploy ${tag} activated\n`);
