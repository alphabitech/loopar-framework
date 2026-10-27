'use strict';

import crypto from 'node:crypto';
import { loopar } from 'loopar';
import { StorageDriver } from './storage-driver.js';
import { assertSafeUpload, assertSafeRemoteUrl } from './upload-guard.js';

/**
 * CloudinaryDriver — persists assets on Cloudinary via the native REST API.
 *
 * No SDK: we sign requests with sha1(sortedParams + apiSecret) and use the
 * native `fetch` + `FormData` available on Node 18+. Keeping this in-house
 * means future drivers (S3/R2) can follow the same shape without dragging
 * a vendor SDK into the core.
 *
 * Tenant segmentation: assets land under `{folderRoot}/{tenantId}/{app}/{visibility}/`.
 * With a single Cloudinary account, that gives a clean per-tenant view in
 * the Cloudinary dashboard and prepares us for per-tenant credentials
 * later without a schema change.
 *
 * Resource type: we upload everything as `auto` so Cloudinary picks
 * image/video/raw. The `secure_url` returned reflects the right
 * resource_type — we store that URL in `external_url` and use it as the
 * source of truth at delivery time, so we never have to remember the
 * resource_type out-of-band.
 */
export class CloudinaryDriver extends StorageDriver {
  #cloudName;
  #apiKey;
  #apiSecret;
  #folderRoot;
  #uploadBase;
  #destroyBase;

  /**
   * Built from a `Cloudinary` storage Single via its `buildDriver()`.
   * Maps the Single's fields to Cloudinary's vocabulary:
   *
   *   provider_id → cloud name   (the slug in the dashboard, e.g. "dxwex1ys6")
   *   access_key  → API key
   *   secret_key  → API secret
   *   folder_root → root prefix under which tenant/app folders are nested
   */
  constructor({ provider_id, access_key, secret_key, folder_root } = {}) {
    super();

    if (!provider_id || !access_key || !secret_key) {
      throw new Error('CloudinaryDriver requires provider_id (cloud name), access_key and secret_key');
    }

    this.#cloudName = provider_id;
    this.#apiKey = access_key;
    this.#apiSecret = secret_key;
    this.#folderRoot = folder_root || 'loopar';
    this.#uploadBase = `https://api.cloudinary.com/v1_1/${encodeURIComponent(provider_id)}`;
    this.#destroyBase = this.#uploadBase;
  }

  get name() {
    return 'cloudinary';
  }

  /**
   * Compute the logical folder for an asset.
   *   {root}/{tenantId}/{app or "shared"}/{visibility}
   *
   * Per-tenant + per-app segmentation is intentional — Alfredo wants
   * the Cloudinary tree to read like a sitemap (site → app → public),
   * even when tenantId and app happen to share the same slug.
   */
  #folder({ app, visibility }) {
    const tenantId = loopar.tenantId || 'default';
    const appSeg = app && app.length > 0 ? app : 'shared';
    const vis = visibility || 'public';
    return `${this.#folderRoot}/${tenantId}/${appSeg}/${vis}`;
  }

  /**
   * Sign a request: sort params alphabetically, join `key=value` with `&`,
   * append apiSecret, sha1, hex. Standard Cloudinary scheme.
   *
   * Excluded from the signature: `file`, `cloud_name`, `resource_type`,
   * `api_key`, `signature` itself.
   */
  #sign(params) {
    const EXCLUDED = new Set(['file', 'cloud_name', 'resource_type', 'api_key', 'signature']);
    const sorted = Object.entries(params)
      .filter(([k, v]) => !EXCLUDED.has(k) && v !== undefined && v !== null && v !== '')
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : v}`)
      .join('&');
    return crypto.createHash('sha1').update(sorted + this.#apiSecret).digest('hex');
  }

  /**
   * Build a multipart/form-data body manually as a single Buffer.
   *
   * We do this by hand instead of using the global `FormData` + `fetch`
   * because Node's undici-backed fetch has a long history of producing
   * malformed multipart bodies when the value is a Blob wrapping a
   * Buffer — the upstream nginx at Cloudinary then returns a generic
   * 502 (Content-Length mismatch / truncated body / boundary issues).
   * Manual construction is ~30 lines, no deps, and matches what curl
   * sends byte-for-byte.
   *
   * Returns `{ body: Buffer, contentType: string }` — pass both
   * straight to fetch.
   */
  #buildMultipart(params, file) {
    const boundary = '----LooparBoundary' + crypto.randomBytes(16).toString('hex');
    const delim = `--${boundary}\r\n`;
    const close = `--${boundary}--\r\n`;
    const chunks = [];

    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === '') continue;
      const val = typeof v === 'boolean' ? String(v) : String(v);
      chunks.push(Buffer.from(delim));
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${k}"\r\n\r\n`));
      chunks.push(Buffer.from(val, 'utf8'));
      chunks.push(Buffer.from('\r\n'));
    }

    if (file) {
      chunks.push(Buffer.from(delim));
      if (Buffer.isBuffer(file.data)) {
        const safeName = (file.filename || 'upload').replace(/["\r\n]/g, '');
        chunks.push(Buffer.from(
          `Content-Disposition: form-data; name="file"; filename="${safeName}"\r\n` +
          `Content-Type: ${file.contentType || 'application/octet-stream'}\r\n\r\n`
        ));
        chunks.push(file.data);
        chunks.push(Buffer.from('\r\n'));
      } else {
        // Remote URL — Cloudinary fetches it server-side.
        chunks.push(Buffer.from(`Content-Disposition: form-data; name="file"\r\n\r\n`));
        chunks.push(Buffer.from(String(file.data), 'utf8'));
        chunks.push(Buffer.from('\r\n'));
      }
    }

    chunks.push(Buffer.from(close));

    return {
      body: Buffer.concat(chunks),
      contentType: `multipart/form-data; boundary=${boundary}`,
    };
  }

  /**
   * Sign and serialize the upload request. `file` is either:
   *   - `{ data: Buffer, filename, contentType }` for binary upload
   *   - `{ data: "https://..." }`                  for remote URL import
   *   - `null`                                     for non-file calls
   */
  #buildUploadRequest({ file, fileName, folder, contentType, extraParams = {} }) {
    const timestamp = Math.floor(Date.now() / 1000);

    const signedParams = {
      timestamp,
      folder,
      use_filename: 'true',
      unique_filename: 'true',
      ...extraParams,
    };
    const signature = this.#sign(signedParams);

    const allParams = {
      ...signedParams,
      api_key: this.#apiKey,
      signature,
    };

    let fileSpec = null;
    if (file) {
      if (Buffer.isBuffer(file)) {
        fileSpec = { data: file, filename: fileName, contentType };
      } else {
        fileSpec = { data: String(file) };
      }
    }

    return this.#buildMultipart(allParams, fileSpec);
  }

  async #postUpload({ body, contentType }) {
    const url = `${this.#uploadBase}/auto/upload`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(body.length),
      },
      body,
    });
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = null; }

    if (!res.ok) {
      const jsonMsg = parsed?.error?.message;
      console.error('[CloudinaryDriver] upload failed:', {
        url,
        status: res.status,
        statusText: res.statusText,
        contentType: res.headers.get('content-type'),
        bodyLength: body.length,
        body: text.slice(0, 1000),
      });
      const detail = jsonMsg
        ? jsonMsg
        : `non-JSON response (${res.status} ${res.statusText}) — see server log`;
      throw new Error(`CloudinaryDriver upload failed: ${detail}`);
    }
    return parsed;
  }

  #buildResult(body, fallbackName) {
    // `storedName` must mirror EXACTLY what the client uploaded, so
    // any reference in a saved doc (`{ name }` in a designer field,
    // `/assets/public/{name}` requested by the browser) can be
    // resolved back through `File Manager.name` and the mirror file.
    //
    // Why we don't trust `body.original_filename + body.format`:
    // Cloudinary normalizes extensions when it reports `format`
    // (`jpeg` → `jpg`, `tiff` → `tif`, etc.). So a file uploaded as
    // `foo.jpeg` round-trips through Cloudinary as `original_filename
    // = "foo"`, `format = "jpg"` — losing the original extension. The
    // browser would then request `foo.jpeg`, the mirror would be
    // `foo.jpg.meta.json`, and the lookup fails.
    //
    // The fallbackName parameter is the `originalName` we handed to
    // the driver, which is the client's filename verbatim. That's
    // what we want as the storedName. `body.original_filename + format`
    // is only a last resort for the unlikely case where fallbackName
    // is missing.
    const reconstructed = body.original_filename
      ? `${body.original_filename}${body.format ? '.' + body.format : ''}`
      : null;

    return {
      externalId: body.public_id,
      src: body.secure_url,
      bytes: body.bytes ?? null,
      format: body.format ?? null,
      width: body.width ?? null,
      height: body.height ?? null,
      storedName: fallbackName || reconstructed,
    };
  }

  async upload({ buffer, originalName, app, visibility, contentType }) {
    if (!buffer || !Buffer.isBuffer(buffer)) {
      throw new Error('CloudinaryDriver.upload: buffer is required');
    }
    assertSafeUpload(originalName, contentType);
    const folder = this.#folder({ app, visibility });
    const req = this.#buildUploadRequest({
      file: buffer,
      fileName: originalName,
      folder,
      contentType,
    });
    const body = await this.#postUpload(req);
    return this.#buildResult(body, originalName);
  }

  async importFromUrl({ url, app, visibility }) {
    if (!url) throw new Error('CloudinaryDriver.importFromUrl: url is required');
    await assertSafeRemoteUrl(url);
    const folder = this.#folder({ app, visibility });
    const req = this.#buildUploadRequest({ file: url, folder });
    const body = await this.#postUpload(req);

    // Derive an originalName from the URL for the entity's records.
    let originalName;
    try {
      const u = new URL(url);
      const last = u.pathname.split('/').filter(Boolean).pop();
      originalName = last ? decodeURIComponent(last) : (body.public_id || `import_${Date.now()}`);
    } catch {
      originalName = body.public_id || `import_${Date.now()}`;
    }

    const result = this.#buildResult(body, originalName);
    return { ...result, originalName };
  }

  async delete({ externalId }) {
    if (!externalId) return;
    const timestamp = Math.floor(Date.now() / 1000);
    const signedParams = { public_id: externalId, timestamp };
    const signature = this.#sign(signedParams);

    // The destroy endpoint has no file payload — use the same hand-built
    // multipart encoder (single boundary, no binary part) for consistency
    // with `upload`/`importFromUrl`. We try image/video/raw in order
    // because we don't know which resource_type was assigned at upload
    // (we only persist the public_id).
    const types = ['image', 'video', 'raw'];
    for (const type of types) {
      const { body: reqBody, contentType } = this.#buildMultipart({
        public_id: externalId,
        timestamp: String(timestamp),
        api_key: this.#apiKey,
        signature,
      }, null);

      try {
        const res = await fetch(`${this.#destroyBase}/${type}/destroy`, {
          method: 'POST',
          headers: {
            'Content-Type': contentType,
            'Content-Length': String(reqBody.length),
          },
          body: reqBody,
        });
        if (!res.ok) continue;
        const body = await res.json().catch(() => ({}));
        if (body.result === 'ok') return;
      } catch (err) {
        console.warn(`[CloudinaryDriver] destroy(${type}) error:`, err?.message || err);
      }
    }
  }

  /**
   * Inject a transformation segment into the delivery URL.
   *
   * Cloudinary URLs look like:
   *   https://res.cloudinary.com/{cloud}/{type}/upload/{transforms/}{version/}{public_id}.{format}
   *
   * We splice our transform right after `/upload/`. Multiple
   * transformation segments are allowed and chained left-to-right, so
   * if the URL already had one, our addition becomes the second.
   */
  deliveryUrl({ src, transform }) {
    if (!src) return src;
    if (!transform) return src;

    const segment = this.#buildTransform(transform);
    if (!segment) return src;

    const marker = '/upload/';
    const idx = src.indexOf(marker);
    if (idx === -1) return src;

    const head = src.slice(0, idx + marker.length);
    const tail = src.slice(idx + marker.length);
    return `${head}${segment}/${tail}`;
  }

  /**
   * Translate the neutral transform object to Cloudinary's URL syntax.
   *   width/height → w_/h_
   *   fit          → c_fill | c_fit | c_pad ...
   *   format       → f_auto | f_webp | f_jpg ...
   *   quality      → q_auto | q_80 ...
   */
  #buildTransform(t) {
    const parts = [];
    const fitMap = {
      cover: 'c_fill',
      contain: 'c_fit',
      fill: 'c_scale',
      pad: 'c_pad',
      thumb: 'c_thumb',
    };
    if (t.fit && fitMap[t.fit]) parts.push(fitMap[t.fit]);
    else if (t.width || t.height) parts.push('c_fill');

    if (t.width) parts.push(`w_${parseInt(t.width, 10)}`);
    if (t.height) parts.push(`h_${parseInt(t.height, 10)}`);
    if (t.format) parts.push(`f_${t.format}`);
    if (t.quality) parts.push(`q_${t.quality}`);

    return parts.join(',');
  }
}

export default CloudinaryDriver;
