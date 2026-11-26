'use strict';

import fs from 'fs';
import path from 'pathe';
import { loopar } from '../loopar.js';
import { setAssetsVersionResolver } from '../global/assets-version.js';

/** How long a tenant's stamp is reused before its folders are looked at again. */
const TTL_MS = 5000;
const stamps = new Map();

/**
 * Newest modification among the folders `/assets/public` is served from (and
 * their subfolders: thumbnails, images…). A folder's mtime moves when a file in it is created,
 * removed or replaced by a new one (upload, git pull, rsync, mv) — not when a
 * file is rewritten in place (`cp` over it): touch the folder in that case.
 */
function readStamp() {
  let newest = 0;
  const look = (dir) => {
    try { newest = Math.max(newest, fs.statSync(dir).mtimeMs); } catch { /* no such folder */ }
  };
  for (const root of loopar.getAssetRoots('public')) {
    look(root);
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) if (entry.isDirectory()) look(path.join(root, entry.name));
  }
  return Math.floor(newest).toString(36);
}

function tenantAssetsVersion() {
  const tenant = loopar.requestTenantId;
  if (!tenant) return '';
  const apps = loopar.__installed__ ? Object.keys(loopar.installedApps || {}).length : 0;
  const key = `${tenant}|${apps}`;
  const hit = stamps.get(key);
  const now = Date.now();
  if (hit && now - hit.at < TTL_MS) return hit.value;
  const value = readStamp();
  stamps.set(key, { at: now, value });
  return value;
}

export function installAssetsVersion() {
  setAssetsVersionResolver(tenantAssetsVersion);
}
