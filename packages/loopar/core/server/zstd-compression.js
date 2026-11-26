import { createReadStream, readdirSync, statSync } from 'fs';
import { extname, join, posix, relative, resolve, sep } from 'path';
import { isBuildAsset, IMMUTABLE_CACHE } from './build-info.js';

/**
 * Pre-built static asset middleware.
 *
 * Serves brotli/zstd/gzip variants from disk based on Accept-Encoding,
 * skipping the cost of on-the-fly compression for bundle assets that
 * Vite already compressed during build.
 *
 * Design notes:
 *   - Variants are indexed at startup (one recursive scan of `root`).
 *     Each request becomes a Map.get() + streamed read — zero filesystem
 *     stats in the hot path.
 *   - Files are streamed (createReadStream + pipe), not read into a
 *     Buffer, so memory stays constant under concurrent load.
 *   - Cache-Control adapts to the path: the build's hashed files
 *     (/assets/<file>) get 1-year-immutable; the rest 5-minute must-revalidate so
 *     deploys aren't frozen in client caches.
 *   - HEAD requests get the same headers without the body.
 *   - On a missed variant or unsupported encoding, we fall through to
 *     next() so Express's compression() middleware can handle it on
 *     the fly.
 *
 * @param {object} options
 * @param {string} options.root      Directory containing pre-built assets.
 * @param {string[]} options.priority Encodings to consider, in preference
 *                                    order. Default ['zst','br','gz'].
 *                                    First match in this list wins per file.
 */
export function zstdMiddleware(options = {}) {
  const {
    root = 'dist/client',
    priority = ['zst', 'br', 'gz'],
  } = options;

  const safeRoot = resolve(root);
  const enabledExt = new Set(['.js', '.mjs', '.css', '.html', '.json', '.svg']);

  // One-time index: url-path → best variant ext for that asset.
  // e.g. variants.get('/assets/main-DI7pTP4G.js') === 'br'
  const variants = buildVariantsIndex(safeRoot, priority);

  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();

    const ext = extname(req.path).toLowerCase();
    if (!enabledExt.has(ext)) return next();

    const variant = variants.get(req.path);
    if (!variant) return next();

    const acceptEncoding = req.headers['accept-encoding'] || '';
    if (!acceptEncoding.includes(ENCODING_NAME[variant])) {
      // Best variant on disk isn't accepted by this client. Let the
      // next compression layer (Express compression()) handle it.
      return next();
    }

    // Defensive path containment. Express normalises req.path, but a
    // misconfigured proxy upstream could still bypass that.
    const onDisk = resolve(safeRoot, '.' + req.path) + '.' + variant;
    if (!onDisk.startsWith(safeRoot + sep)) return next();

    serveCompressed(req, res, onDisk, variant, ext, req.path);
  };
}

/* ------------------------------------------------------------------ */
/* Internals                                                           */
/* ------------------------------------------------------------------ */

const ENCODING_NAME = Object.freeze({
  zst: 'zstd',
  br:  'br',
  gz:  'gzip',
});

const CONTENT_TYPES = Object.freeze({
  '.js':   'application/javascript',
  '.mjs':  'application/javascript',
  '.css':  'text/css',
  '.html': 'text/html',
  '.json': 'application/json',
  '.svg':  'image/svg+xml',
});

function cacheControlFor(urlPath) {
  return isBuildAsset(urlPath)
    ? IMMUTABLE_CACHE
    : 'public, max-age=300, must-revalidate';
}

function setCompressedHeaders(res, variant, ext, urlPath) {
  res.setHeader('Content-Encoding', ENCODING_NAME[variant]);
  res.setHeader('Content-Type', CONTENT_TYPES[ext] || 'application/octet-stream');
  res.setHeader('Vary', 'Accept-Encoding');
  res.setHeader('Cache-Control', cacheControlFor(urlPath));
}

function serveCompressed(req, res, filePath, variant, ext, urlPath) {
  setCompressedHeaders(res, variant, ext, urlPath);

  if (req.method === 'HEAD') return res.end();

  const stream = createReadStream(filePath);
  stream.once('error', (err) => {
    // Index claimed the file existed but it's gone — could be a deploy
    // mid-request, or a filesystem hiccup. Don't crash; if headers
    // haven't flushed yet, hand off to the next middleware. Otherwise
    // just close the response so the client doesn't hang.
    if (res.headersSent) return res.destroy(err);
    res.removeHeader('Content-Encoding');
    res.removeHeader('Content-Type');
    res.removeHeader('Vary');
    res.removeHeader('Cache-Control');
    // eslint-disable-next-line no-console
    console.error('[zstdMiddleware] file vanished from disk:', filePath, err.code);
    res.status(500).end();
  });
  stream.pipe(res);
}

/**
 * Recursively scan `root` and build the variants index. Sync I/O is fine
 * here — this runs exactly once at startup. Bundle directories typically
 * have a few hundred files; the scan finishes in tens of milliseconds.
 *
 * For each base file, the variant present with the highest priority is
 * recorded. e.g. if both `main.js.br` and `main.js.gz` exist and priority
 * is `['zst','br','gz']`, `br` wins.
 */
function buildVariantsIndex(root, priority) {
  const index = new Map();

  let stat;
  try { stat = statSync(root); } catch { return index; }
  if (!stat.isDirectory()) return index;

  const score = (ext) => {
    const i = priority.indexOf(ext);
    return i === -1 ? -1 : priority.length - i;
  };

  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch { return; }

    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;

      const dotIdx = entry.name.lastIndexOf('.');
      if (dotIdx === -1) continue;

      const variantExt = entry.name.slice(dotIdx + 1);
      if (!priority.includes(variantExt)) continue;

      // Strip the .gz/.br/.zst suffix to recover the URL path of the
      // original asset. Normalize separators so Windows builds also
      // produce posix-style URLs.
      const rel = relative(root, full).split(sep).join(posix.sep);
      const originalUrl = '/' + rel.slice(0, -(variantExt.length + 1));

      const existing = index.get(originalUrl);
      if (!existing || score(existing) < score(variantExt)) {
        index.set(originalUrl, variantExt);
      }
    }
  };

  walk(root);
  return index;
}
