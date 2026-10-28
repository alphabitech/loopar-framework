'use strict';

import fs from 'fs';
import path from 'pathe';
import { loopar } from '../loopar.js';
import { PermissionManager } from '../auth/PermissionManager.js';

/**
 * Private files (file fields flagged `private`) and the record they belong to.
 *
 * Lifecycle, audit-friendly:
 *  - The record is soft-deleted → its files stay (it can be restored), but only
 *    the Administrator can open them meanwhile.
 *  - The record is deleted for good → its files are deleted too, including
 *    earlier versions replaced in the field (kept until then for the history).
 */

/** Sidecars (`{file}.meta.json`) of the private files owned by entity/name. */
async function ownedSidecars(entity, name) {
  const found = [];
  for (const root of loopar.getAssetRoots('private')) {
    let entries;
    try { entries = await fs.promises.readdir(root); } catch { continue; }
    for (const entry of entries) {
      if (!entry.endsWith('.meta.json')) continue;
      try {
        const meta = JSON.parse(await fs.promises.readFile(path.join(root, entry), 'utf8'));
        if (meta?.owner?.entity === entity && meta.owner.name === name) found.push(meta);
      } catch {}
    }
  }
  return found;
}

/** Deletes every private file of a record (binary, thumbnail and sidecar). */
export async function purgePrivateFiles(entity, name) {
  for (const meta of await ownedSidecars(entity, name)) {
    try {
      const file = await loopar.newDocument('File Manager');
      file.name = meta.name;
      file.visible = 'private';
      file.storage_driver = meta.storage_driver;
      file.external_id = meta.external_id;
      await file.delete();
    } catch (err) {
      console.warn(`[private files] could not delete ${meta.name}:`, err?.message || err);
    }
  }
}

/**
 * Whether `user` may open a private file: the record it belongs to exists,
 * the user was granted view on it (a public view doesn't count; own records
 * only, when that is the granted scope) and it is
 * not soft-deleted — except for the Administrator, who audits deleted ones.
 * Files without an owner need File Manager access.
 */
export async function mayReadPrivateFile(meta, user) {
  const owner = meta?.owner;
  if (!owner?.entity) return !!PermissionManager.grantedScope('File Manager', 'view', user);

  // A granted permission: a record whose view is public still keeps its private files.
  const scope = PermissionManager.grantedScope(owner.entity, 'view', user);
  if (!scope || !owner.name) return false;

  let row;
  try {
    row = await loopar.db.qx()(owner.entity).where({ name: owner.name }).first();
  } catch {
    return false;
  }
  if (!row) return false;
  if (row.__deleted_at__ && user !== 'Administrator') return false;
  if (scope === 'own' && row.__created_by__ !== user) return false;
  return true;
}
