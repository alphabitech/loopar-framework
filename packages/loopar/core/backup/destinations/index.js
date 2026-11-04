'use strict';

import { S3Destination } from './s3.js';
import { SftpDestination } from './sftp.js';
import { WebdavDestination } from './webdav.js';
import { GdriveDestination } from './gdrive.js';

export const DESTINATIONS = Object.freeze({
  s3: { label: 'S3-compatible (AWS, R2, B2, Spaces, MinIO, GCS)', Class: S3Destination },
  sftp: { label: 'SFTP', Class: SftpDestination },
  webdav: { label: 'WebDAV (Nextcloud, ownCloud, NAS…)', Class: WebdavDestination },
  gdrive: { label: 'Google Drive', Class: GdriveDestination },
});

/**
 * The remote destination of a tenant's settings, or null when backups stay
 * local only. Every destination implements:
 *   upload(localFile, tenant, file) · download(tenant, file, localFile)
 *   remove(tenant, file) · list(tenant) → [{ file, size, modifiedAt }]
 */
export function makeDestination(settings) {
  const key = String(settings?.destination || 'local').toLowerCase();
  if (key === 'local' || key === 'none' || !key) return null;
  const d = DESTINATIONS[key];
  if (!d) throw new Error(`Unknown backup destination "${key}".`);
  return new d.Class(settings);
}

export { gdriveAuthUrl, gdriveExchangeCode } from './gdrive.js';
export { signV4 } from './s3.js';
