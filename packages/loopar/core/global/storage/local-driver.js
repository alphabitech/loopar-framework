'use strict';

import fs from 'fs';
import path from 'pathe';
import { loopar } from 'loopar';
import { StorageDriver } from './storage-driver.js';
import { assertSafeUpload, assertSafeRemoteUrl } from './upload-guard.js';

/**
 * LocalDriver — persists assets on the local filesystem.
 *
 * Default driver. Replicates the historical Loopar behavior: assets live
 * under `apps/{app}/uploads/{visibility}/` when scoped to an app,
 * otherwise under `{tenant}/uploads/{visibility}/`. The public URL is
 * `/assets/{visibility}/{name}`, served by the static middleware in
 * `core/server/server.js`.
 *
 * Sharp is loaded lazily on first thumbnail request so the package stays
 * importable on hosts where Sharp can't compile. Thumbnail failures are
 * non-fatal: the upload still succeeds.
 */
export class LocalDriver extends StorageDriver {
  #sharp = null;
  #sharpLoadAttempted = false;

  get name() {
    return 'local';
  }

  #pathBase({ app, visibility }) {
    const v = visibility || 'public';
    if (app && app.length > 0) {
      return loopar.makePath(loopar.pathRoot, 'apps', app, 'uploads', v);
    }
    return loopar.makePath(loopar.tenantPath, 'uploads', v);
  }

  #thumbnailDir(base) {
    return loopar.makePath(base, 'thumbnails');
  }

  /** Detect latin1-encoded utf8 (multer mojibake) without Unicode literals. */
  #hasC1Controls(s) {
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c >= 0x80 && c <= 0x9F) return true;
    }
    return false;
  }

  #normalizeFileName(name = '') {
    if (typeof name !== 'string') return '';
    let normalized = name;
    if (this.#hasC1Controls(normalized)) {
      normalized = Buffer.from(normalized, 'latin1').toString('utf8');
    }
    
    return normalized.normalize('NFKC').replace(/\s+/g, ' ').trim();
  }

  async #getSharp() {
    if (this.#sharp || this.#sharpLoadAttempted) return this.#sharp;
    this.#sharpLoadAttempted = true;
    try {
      const mod = await import('sharp');
      this.#sharp = mod.default || mod;
    } catch (err) {
      console.warn('[LocalDriver] sharp not available; image thumbnails disabled.', err?.message || err);
      this.#sharp = null;
    }
    return this.#sharp;
  }

  /**
   * Write `buffer` to `filePath`. If a file already exists with different
   * content, rename with `_{Date.now()}` and retry. Returns the actual
   * basename written.
   */
  async #writeWithCollision(filePath, buffer) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    if (fs.existsSync(filePath)) {
      const existing = fs.readFileSync(filePath);
      if (existing.equals(buffer)) {
        return path.basename(filePath);
      }
      const parsed = path.parse(filePath);
      const renamed = path.join(parsed.dir, `${parsed.name}_${Date.now()}${parsed.ext}`);
      return await this.#writeWithCollision(renamed, buffer);
    }

    await fs.promises.writeFile(filePath, buffer);
    return path.basename(filePath);
  }

  async upload({ buffer, originalName, app, visibility, contentType }) {
    if (!buffer || !Buffer.isBuffer(buffer)) {
      throw new Error('LocalDriver.upload: buffer is required');
    }

    // Reject active content that the browser would execute in our origin
    // when the file is later served inline (SVG/HTML/JS…).
    assertSafeUpload(originalName, contentType);

    const base = this.#pathBase({ app, visibility });
    fs.mkdirSync(base, { recursive: true });

    const cleanName = this.#normalizeFileName(originalName) || `file_${Date.now()}`;
    const filePath = path.join(base, cleanName);

    const storedName = await this.#writeWithCollision(filePath, buffer);
    const storedPath = path.join(base, storedName);

    if ((contentType || '').startsWith('image/')) {
      const sharp = await this.#getSharp();
      if (sharp) {
        try {
          const thumbDir = this.#thumbnailDir(base);
          fs.mkdirSync(thumbDir, { recursive: true });
          const thumbPath = path.join(thumbDir, storedName);
          if (!fs.existsSync(thumbPath)) {
            await sharp(buffer).resize(200, 200).toFile(thumbPath);
          }
        } catch (err) {
          console.warn('[LocalDriver] thumbnail generation failed:', err?.message || err);
        }
      }
    }

    const stat = fs.statSync(storedPath);
    return {
      externalId: null,
      src: `/assets/${visibility || 'public'}/${encodeURIComponent(storedName)}`,
      bytes: stat.size,
      format: path.extname(storedName).slice(1).toLowerCase() || null,
      width: null,
      height: null,
      storedName,
    };
  }

  async importFromUrl({ url, app, visibility }) {
    // SSRF guard: only http(s) to a public host.
    await assertSafeRemoteUrl(url);
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`LocalDriver.importFromUrl: ${res.status} ${res.statusText} for ${url}`);
    }
    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const contentType = res.headers.get('content-type') || null;

    let originalName;
    try {
      const u = new URL(url);
      const last = u.pathname.split('/').filter(Boolean).pop();
      originalName = last ? decodeURIComponent(last) : `import_${Date.now()}`;
    } catch {
      originalName = `import_${Date.now()}`;
    }

    const result = await this.upload({ buffer, originalName, app, visibility, contentType });
    return { ...result, originalName };
  }

  async delete({ storedName, app, visibility }) {
    if (!storedName) return;
    const base = this.#pathBase({ app, visibility });
    const filePath = path.join(base, storedName);

    try {
      if (!fs.existsSync(filePath)) return;
      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) {
        fs.rmSync(filePath, { recursive: true, force: true });
      } else {
        fs.unlinkSync(filePath);
        const thumb = path.join(this.#thumbnailDir(base), storedName);
        if (fs.existsSync(thumb)) fs.unlinkSync(thumb);
      }
    } catch (err) {
      console.warn('[LocalDriver] delete failed:', err?.message || err);
    }
  }

  /**
   * For local assets, `src` is already a `/assets/...` path. The only
   * transform we honor is a size hint that maps to the `thumbnails/`
   * directory — preserves the historical preview behavior without
   * coupling callers to driver internals. SVG/ICO always return as-is.
   */
  deliveryUrl({ src, transform }) {
    if (!src) return src;
    if (!transform) return src;

    const wantsResize = transform.width || transform.height;
    if (!wantsResize) return src;

    const lower = src.toLowerCase();
    if (lower.endsWith('.svg') || lower.endsWith('.ico')) return src;

    const marker = '/assets/';
    const idx = src.indexOf(marker);
    if (idx === -1) return src;

    const head = src.slice(0, idx + marker.length);
    const tail = src.slice(idx + marker.length);
    const slash = tail.indexOf('/');
    if (slash === -1) return src;

    const visibility = tail.slice(0, slash);
    const rest = tail.slice(slash + 1);
    return `${head}${visibility}/thumbnails/${rest}`;
  }
}

export default LocalDriver;
