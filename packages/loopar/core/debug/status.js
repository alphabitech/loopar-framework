'use strict';

/**
 * Framework status for the Debugger's "Status" panel and /api/Debugger/status:
 * what is running (versions, mode, build, memory), how the current tenant
 * is set up (DB dialect, install state) and whether any installed app has a
 * newer version on disk than in its database (an update is pending).
 *
 * Scoped to the requesting tenant: nothing about other tenants is exposed.
 */

import fs from 'fs';
import os from 'os';
import path from 'pathe';
import { loopar } from '../loopar.js';
import { coreEnv, corePort } from '../config/core-config.js';
import { shouldServeProduction, distIsReady } from '../server/runtime-mode.js';
import { buildId } from '../server/build-info.js';
import { getTenant } from '../server/router/request-context.js';
import { redisEnabled } from '../redis/redis-client.js';
import { debugCollector } from './collector.js';
import { listLocalBackups } from '../backup/engine.js';

const readJSON = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
};
const mb = (bytes) => Math.round((bytes / 1024 / 1024) * 10) / 10;

function appsOnDisk(root) {
  const out = {};
  const dir = path.join(root, 'apps');
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return out; }
  for (const name of names) {
    const installer = readJSON(path.join(dir, name, 'installer.json'));
    if (installer?.App?.name) out[installer.App.name] = installer.App.version ?? null;
  }
  return out;
}

async function appsInDatabase() {
  try {
    return await loopar.db.getAll('App', ['name', 'version']);
  } catch {
    return [];
  }
}

export async function frameworkStatus() {
  const root = process.cwd();
  const rootPkg = readJSON(path.join(root, 'package.json'));
  const looparPkg = readJSON(path.join(root, 'packages', 'loopar', 'package.json'));
  const mem = process.memoryUsage();
  const t = getTenant();

  let mode = 'development';
  try { mode = coreEnv(); } catch { /* defaults */ }

  const framework = {
    name: rootPkg?.name ?? 'loopar',
    version: rootPkg?.version ?? null,
    looparPackage: looparPkg?.version ?? null,
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    pid: process.pid,
    uptimeSec: Math.round(process.uptime()),
    memory: { rssMb: mb(mem.rss), heapUsedMb: mb(mem.heapUsed), heapTotalMb: mb(mem.heapTotal), externalMb: mb(mem.external) },
    cpus: os.cpus()?.length ?? null,
    loadavg: os.loadavg().map((n) => Math.round(n * 100) / 100),
    mode,
    servingDist: shouldServeProduction(),
    distReady: distIsReady(),
    build: buildId(),
    port: corePort(),
    redis: redisEnabled(),
    debug: debugCollector.enabled,
  };

  const tenant = {
    name: loopar.requestTenantId ?? null,
    domain: t?.domain ?? null,
    website: t?.webApp ?? null,
    installed: !!loopar.__installed__,
    dbServerInitialized: !!loopar.DBServerInitialized,
    dbInitialized: !!loopar.DBInitialized,
    db: { dialect: loopar.db?.dialect || null, database: loopar.db?.database || null },
  };

  const disk = appsOnDisk(root);
  const installed = Object.keys(loopar.installedApps || {});
  const dbApps = tenant.installed ? await appsInDatabase() : [];
  const byName = new Map(dbApps.map((a) => [a.name, a.version ?? null]));
  const apps = installed.map((name) => {
    const installedVersion = byName.get(name) ?? null;
    const available = disk[name] ?? null;
    return {
      name,
      installedVersion,
      availableVersion: available,
      updatePending: !!(available && installedVersion && available !== installedVersion),
      onDisk: name in disk,
    };
  });

  const backups = tenant.name ? listLocalBackups(root, tenant.name) : [];
  const backup = {
    count: backups.length,
    last: backups[0] ? { file: backups[0].file, kind: backups[0].kind, at: backups[0].date.toISOString() } : null,
    lastScheduled: backups.find((b) => b.kind === 'scheduled')?.date.toISOString() ?? null,
  };

  return {
    at: new Date().toISOString(),
    framework,
    tenant,
    apps,
    backup,
    collector: debugCollector.stats(tenant.name),
  };
}
