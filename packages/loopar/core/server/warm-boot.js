'use strict';

/**
 * Boot warm-up and PM2 readiness for the core process.
 *
 * Why this exists: app server code (models, controllers) used to load lazily,
 * on the first request that needed it. Node caches each ES module by URL for
 * the life of the process, so after a `git pull` of an app the running core
 * served a MIX of versions — modules already imported kept the old code,
 * modules imported later read the new files from disk.
 *
 * Warming every active tenant and importing every model/controller of its
 * installed apps at boot turns the process into a consistent snapshot of the
 * code on disk when it started: a pull does not leak in until the next
 * reload. Imports use the exact paths the router and documentManage use, so
 * they hit the same ESM cache entries at request time.
 *
 * Only after the warm-up does the process tell PM2 it is ready
 * (wait_ready in bin/cli/pm2.js), so a reload hands traffic to a worker that
 * already serves every tenant without a cold first request.
 */

import { once } from 'node:events';
import { fileManage } from '../file-manage.js';
import { requestContext } from './router/request-context.js';
import { tenantRegistry } from './tenant-registry.js';

const TENANT_WARM_TIMEOUT_MS = Number(process.env.TENANT_WARM_TIMEOUT_MS ?? 20000);
const SHUTDOWN_GRACE_MS = 8000;

const withTimeout = (promise, ms, label) => {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

/** Import every model and controller of the tenant's installed apps. */
async function preloadServerModules(inst, seen) {
  let loaded = 0;
  let failed = 0;

  for (const ref of Object.values(inst.getRefs() || {})) {
    if (!ref?.__ROOT__ || !ref.__NAME__) continue;

    const files = [
      inst.makePath(ref.__ROOT__, `${ref.__NAME__}.js`),            // documentManage #importDocument
      inst.makePath(ref.__ROOT__, `${ref.__NAME__}Controller.js`),  // router executeController
    ];

    for (const file of files) {
      if (seen.has(file)) continue;
      seen.add(file);

      try {
        if (await fileManage.importClass(file, () => null)) loaded++;
      } catch (err) {
        failed++;
        console.warn(`[boot] preload failed for ${file}: ${err?.message || err}`);
      }
    }
  }

  return { loaded, failed };
}

/**
 * Connect every active tenant and preload its server code. Never throws: a
 * broken tenant is logged and skipped, it must not keep the core from
 * becoming ready for the others.
 */
async function warmTenants(getOrCreateTenantInstance, appsBasePath) {
  const seen = new Set();
  const stats = { tenants: 0, modules: 0, failed: 0 };

  for (const t of tenantRegistry.all()) {
    if (t.suspended) continue;

    try {
      const inst = await withTimeout(
        getOrCreateTenantInstance(t.name, { appsBasePath }),
        TENANT_WARM_TIMEOUT_MS,
        `tenant ${t.name} init`
      );

      const { loaded, failed } = await requestContext.run(
        { tenant: { name: t.name } },
        () => preloadServerModules(inst, seen)
      );

      stats.tenants++;
      stats.modules += loaded;
      stats.failed += failed;
    } catch (err) {
      stats.failed++;
      console.warn(`[boot] tenant ${t.name} not warmed: ${err?.message || err}`);
    }
  }

  return stats;
}

/**
 * Drain on SIGINT/SIGTERM (PM2 sends SIGINT to the old worker once the new one
 * is ready): stop accepting connections, let in-flight requests finish, exit.
 * Long-lived sockets (realtime) are cut by the grace timer.
 */
function installGracefulShutdown(httpServer) {
  let closing = false;

  const shutdown = (signal) => {
    if (closing) return;
    closing = true;
    console.log(`[core] ${signal} — draining connections…`);

    httpServer.close(() => process.exit(0));
    httpServer.closeIdleConnections?.();
    setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

/**
 * Called by startCore() after the server is initialized: wait for the port,
 * warm tenants, signal PM2. `ready` is sent even if the warm-up fails, so a
 * bad tenant never blocks a reload (PM2's listen_timeout is the backstop).
 */
export async function warmAndSignalReady({ server, getOrCreateTenantInstance, appsBasePath }) {
  const started = Date.now();
  const httpServer = server.httpServer;

  try {
    if (httpServer && !httpServer.listening) await once(httpServer, 'listening');

    const stats = await warmTenants(getOrCreateTenantInstance, appsBasePath);
    console.log(
      `[boot] warmed ${stats.tenants} tenant(s), preloaded ${stats.modules} server module(s)` +
      (stats.failed ? `, ${stats.failed} failure(s)` : '') +
      ` in ${Date.now() - started}ms`
    );
  } catch (err) {
    console.warn(`[boot] warm-up aborted: ${err?.message || err}`);
  } finally {
    if (server.serveProduction && httpServer) installGracefulShutdown(httpServer);
    if (typeof process.send === 'function') process.send('ready');
  }
}
