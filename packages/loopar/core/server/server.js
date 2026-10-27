'use strict';

import cookieParser from "cookie-parser";
import { express as useragent } from "express-useragent";
import express from "express";
import { loopar, getOrCreateTenantInstance, getTenantInstance } from "../loopar.js";
import Router from "./router/router.js";
import path from "pathe";
import compression from 'compression';
import tenantContextMiddleware from "./tenant-context.js"
import { zstdMiddleware } from './zstd-compression.js';
import { requestContext } from './router/request-context.js';
import { tenantRegistry } from './tenant-registry.js';
import { shouldServeProduction } from './runtime-mode.js';
import http from "http";
import { RealtimeManager } from "../realtime/RealtimeManager.js";
import { kioskManifest } from "../global/kiosk-manifest.js";

const server = new express();

// Trust the loopback hop only (Caddy → app) so req.secure comes from Caddy's
// X-Forwarded-Proto; a direct external client isn't loopback and can't spoof it.
server.set('trust proxy', 'loopback');

// Don't advertise the server stack.
server.disable('x-powered-by');

export class Server extends Router {
  server = server;
  url = null;
  // NODE_ENV says production; we only SERVE the prebuilt dist when it also
  // exists (else fall back to Vite, never blank pages) → shouldServeProduction().
  isProduction = process.env.NODE_ENV == 'production';
  get serveProduction() { return shouldServeProduction(); }
  uploadPath = "uploads";

  constructor() { super() }

  async initialize() {
    const requestedPort = parseInt(process.env.PORT, 10);
    if (Number.isNaN(requestedPort)) {
      throw new Error(`Invalid PORT env: "${process.env.PORT}"`);
    }

    // One HTTP server for Express, realtime and Vite HMR — so HMR rides it
    this.httpServer = http.createServer(server);
    this.#installSecurityHeaders();
    this.#installTenantResolution();

    if (this.serveProduction) {
      server.use(compression());
      server.use(zstdMiddleware({
        root: 'dist/client',
        priority: ['zst', 'br', 'gz'],
      }));
    } else {
      // Loaded only in dev: production never touches Vite, and code that
      // imports `loopar` without serving (tests, CLI scripts) doesn't need it.
      const { createServer: createViteServer } = await import('vite');
      this.vite = await createViteServer({
        server: {
          middlewareMode: true,
          ws: { server: this.httpServer },
        },
        appType: 'custom'
      });
      server.use(this.vite.middlewares);
    }

    await this.#exposePublicDirectories();
    server.use(useragent());
    this.#initializeSession();
    this.route();
    this.#start();
  }

  #warnedHosts = new Set();

  async #resolveRequestTenant(req) {
    const byHost = tenantRegistry.resolveHost(req.headers?.host);

    if (!byHost) {
      if (req.headers?.host && !this.#warnedHosts.has(req.headers.host)) {
        this.#warnedHosts.add(req.headers.host);
        console.warn(
          `[tenant] Host "${req.headers.host}" matches no tenant — ` +
          `turn a tenant On whose DOMAIN covers it.`
        );
      }
      return null;
    }

    if (byHost.suspended) {
      const e = new Error('suspended');
      e.suspendedTenant = byHost.name;
      throw e;
    }

    await getOrCreateTenantInstance(byHost.name, { appsBasePath: loopar.appsBasePath });
    return byHost;
  }

  #suspendedPage(name) {
    return `<!doctype html><html><head><meta charset="utf-8">` +
      `<title>Workspace suspended</title></head>` +
      `<body style="display:flex;justify-content:center;align-items:center;` +
      `height:100vh;margin:0;flex-direction:column;background:#0b0b0f;color:#95b3d6;` +
      `font-family:ui-sans-serif,system-ui">` +
      `<h1 style="font-size:64px;margin:0">Suspended</h1>` +
      `<p style="font-size:18px;opacity:.8">This workspace is temporarily unavailable.</p>` +
      `<hr style="width:40%;opacity:.2;margin:20px 0"/>` +
      `<span style="opacity:.6">Loopar</span></body></html>`;
  }

  /**
   * Baseline security headers on every response. Set as the very first
   * middleware so they also ride error pages, asset 404s and the suspended
   * page. HSTS is only emitted over real HTTPS (req.secure, from Caddy's
   * X-Forwarded-Proto) so plain-HTTP-by-IP access isn't locked out.
   *
   * CSP here is intentionally minimal (frame-ancestors / object-src /
   * base-uri): it hardens clickjacking and base-tag injection without a
   * script-src that would break Vite dev and inline SSR. A full script-src
   * policy with nonces is a follow-up. Inline-executable uploads (SVG/HTML)
   * are blocked at upload time instead (upload-guard.js).
   */
  #installSecurityHeaders() {
    this.server.use((req, res, next) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'SAMEORIGIN');
      res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
      res.setHeader('Content-Security-Policy', "frame-ancestors 'self'; object-src 'none'; base-uri 'self'");
      if (req.secure) {
        res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
      }
      next();
    });
  }

  #installTenantResolution() {
    server.use(async (req, res, next) => {
      try {
        const tenant = await this.#resolveRequestTenant(req);
        requestContext.run({ req, res, tenant }, next);
      } catch (err) {
        if (err?.suspendedTenant) {
          if (!res.headersSent) {
            res.status(503)
              .set('Content-Type', 'text/html')
              .set('Retry-After', '3600')
              .send(this.#suspendedPage(err.suspendedTenant));
          }
          return;
        }
        console.error(
          `[tenant] initialization failed for host "${req.headers?.host}": ${err?.message || err}`
        );
        if (!res.headersSent) {
          res.status(503).json({ error: 'Tenant initialization failed, try again shortly' });
        }
      }
    });
  }

  #initializeSession() {
    server.use(cookieParser());
    server.use(express.json({
      limit: '50mb',
      verify: (req, res, buf) => { req.rawBody = buf; }
    }));
    server.use(express.urlencoded({ extended: true, limit: '50mb' }));
    server.use(tenantContextMiddleware);
  }

  async #exposePublicDirectories() {
    // Per-request theme (the host's web app theme, or the tenant's). First,
    // so a static theme.css in dist/ or any public root can never shadow it.
    // The URL carries ?v=<mtime>, so it can be cached hard.
    server.get("/assets/public/theme.css", (req, res, next) => {
      if (!loopar.requestTenantId) return next();
      const cache = req.query?.v ? { maxAge: '1y', immutable: true } : { maxAge: 0 };
      res.sendFile(loopar.themeCssPath(), cache, (err) => {
        if (err) next();
      });
    });

    // Manifest of the kiosk workspace's pages (installable as apps), per web app.
    server.get("/assets/public/kiosk.webmanifest", (req, res, next) => {
      if (!loopar.requestTenantId) return next();
      res.type("application/manifest+json").set("Cache-Control", "no-cache")
        .send(JSON.stringify(kioskManifest(String(req.query?.page || ""))));
    });

    if (this.serveProduction) {
      server.use(express.static(path.join(loopar.pathRoot, 'dist/client')));
    }

    // Tenant-aware static assets: handlers built from the active tenant's roots
    // (resolved per request via the `loopar` proxy). The roots include one
    // folder per installed app, so the cache key carries the installed-app set:
    // installing/uninstalling an app yields a new key instead of serving a
    // stale chain until the next restart.
    const assetChains = new Map();
    server.use("/assets/public", (req, res, next) => {
      const tenantId = loopar.requestTenantId;
      if (!tenantId) return next();

      const apps = loopar.__installed__ ? Object.keys(loopar.installedApps || {}).sort().join(",") : "";
      const key = `${tenantId}|${apps}`;

      let chain = assetChains.get(key);
      if (!chain) {
        for (const k of assetChains.keys()) if (k.startsWith(`${tenantId}|`)) assetChains.delete(k);
        chain = loopar.getAssetRoots("public").map((root) => express.static(root));
        assetChains.set(key, chain);
      }

      let i = 0;
      const advance = (err) => {
        if (err) return next(err);
        if (i >= chain.length) return next();
        chain[i++](req, res, advance);
      };
      advance();
    });

  }

  #start() {
    const port = process.env.PORT;
    const installMessage = loopar.tenantId
      ? (loopar.__installed__ ? '' : '\n\nContinue in your browser to complete the installation')
      : '';

    const httpServer = this.httpServer;

    httpServer.on("error", (err) => {
      if (err && err.code === "EADDRINUSE") {
        console.error(`\n❌ Core port ${port} is already in use.`);
        console.error(`   Inspect:  lsof -nP -iTCP:${port} -sTCP:LISTEN`);
        console.error(`   Change:   edit config/core.json (port) and restart.`);
        console.error(`   The core port is fixed — Caddy routes every tenant domain here — so it is not auto-shifted.\n`);
        process.exit(1);
      }
      throw err;
    });

    RealtimeManager.attach(httpServer, {
      tenantId: null,
      getJwtSecret: () => null,
      getJwtSecretFor: (siteName) => {
        try {
          return getTenantInstance(siteName)?.jwtSecret ?? null;
        } catch {
          return null;
        }
      },
      isKnownTenant: (siteName) => !!tenantRegistry.get(siteName),
    });

    httpServer.listen(port, () => {
      console.log(`Core server listening on ${port} — turn tenants On to serve them.` + installMessage);
    });
  }
}