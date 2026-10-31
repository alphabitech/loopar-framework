'use strict';

/**
 * Build identity — what lets an open browser tab notice it is running an older
 * client bundle than the server (version skew after a zero-downtime deploy).
 *
 *   buildId()          → the release tag `dist` points to (2026-10-31_14-47-39),
 *                        or null when there is no prebuilt dist (development:
 *                        Vite HMR keeps the client current, so the whole
 *                        version-watch machinery stays dormant).
 *   buildIdMiddleware  → stamps `X-Loopar-Build` on every response; the client
 *                        compares it with the build it booted with.
 *   buildEndpoint      → GET /__loopar/build, a tiny no-cache probe the client
 *                        polls when the tab regains focus.
 *   previousAssetsMiddleware → serves hashed client chunks (/assets/<file>)
 *                        from the releases kept on disk, so a tab still on the
 *                        previous bundle can lazy-load a view after the swap
 *                        instead of failing on a 404 chunk.
 *
 * The id is resolved once per process: a worker serves ONE SSR bundle for its
 * whole life (pm2 reload swaps workers), so its answer never changes.
 */

import fs from 'fs';
import path from 'pathe';
import express from 'express';
import { shouldServeProduction } from './runtime-mode.js';

const ROOT = process.cwd();
const RELEASES_DIR = path.join(ROOT, 'build', 'releases');
const HASHED_ASSET = /^\/assets\/([A-Za-z0-9._-]+\.(?:js|mjs|css|woff2?|ttf|svg|png|jpe?g|webp|avif|gif|ico|wasm|map))$/;

let cachedId;

export function buildId() {
  if (cachedId !== undefined) return cachedId;
  cachedId = shouldServeProduction() ? resolveId() : null;
  return cachedId;
}

function resolveId() {
  const dist = path.join(ROOT, 'dist');
  try {
    // Normal layout: dist → build/releases/<tag>
    const real = fs.realpathSync(dist);
    if (path.dirname(real) === RELEASES_DIR) return path.basename(real);
  } catch { /* fall through */ }
  try {
    // Legacy layout (dist is a real folder): the client entry's mtime still
    // changes on every build.
    return 'm' + Math.floor(fs.statSync(path.join(dist, 'client', 'main.html')).mtimeMs).toString(36);
  } catch {
    return null;
  }
}

export function buildIdMiddleware(req, res, next) {
  const id = buildId();
  if (id) res.setHeader('X-Loopar-Build', id);
  next();
}

export function buildEndpoint(req, res) {
  res.set('Cache-Control', 'no-store');
  res.json({ build: buildId() });
}

/**
 * Fallback for hashed client assets missing from the active dist: look in the
 * other releases still on disk (newest first). Only single-segment hashed
 * filenames under /assets/ qualify — never /assets/public|private/… (tenant
 * files) and never a path with separators, so nothing outside the releases'
 * client/assets folders is reachable.
 */
export function previousAssetsMiddleware() {
  let statics = [];
  let scannedAt = 0;

  const refresh = () => {
    const now = Date.now();
    if (now - scannedAt < 60_000) return statics;
    scannedAt = now;
    let current = null;
    try { current = path.basename(fs.realpathSync(path.join(ROOT, 'dist'))); } catch { /* none */ }
    let releases = [];
    try {
      releases = fs.readdirSync(RELEASES_DIR)
        .filter(name => name !== current && fs.existsSync(path.join(RELEASES_DIR, name, 'client', 'assets')))
        .sort().reverse();
    } catch { /* no releases dir */ }
    statics = releases.map(name => express.static(path.join(RELEASES_DIR, name, 'client'), {
      index: false,
      fallthrough: true,
      immutable: true,
      maxAge: '1y',
    }));
    return statics;
  };

  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (!HASHED_ASSET.test(req.path)) return next();
    const chain = refresh();
    let i = 0;
    const tryNext = (err) => {
      if (err) return next(err);
      if (i >= chain.length) return next();
      chain[i++](req, res, tryNext);
    };
    tryNext();
  };
}
