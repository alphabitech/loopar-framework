'use strict';

/**
 * Tenant-stamped console output. One core serves every tenant, so its log
 * files mix them all; a line written inside a tenant's context (a request,
 * a scheduled job — requestContext carries `tenant`) gets `[<tenant>] `
 * in front, which is what the terminal Tenant Manager filters on to show a
 * tenant's own logs. Core-level output (boot, Caddy, tenant-less requests)
 * is left as is.
 *
 * EVERY line of a multi-line message gets the stamp, so each line in the
 * files says whose it is (core/logging/tenant-log.js reads them).
 *
 * Listeners (onTenantLog) get each tenant message as written — the desk
 * Debugger streams them live, so its Logs show exactly what the files hold.
 *
 * Installed by startCore BEFORE the Debugger's console capture, which wraps
 * it and keeps recording the clean text per request.
 */

import util from 'node:util';
import { requestContext } from './router/request-context.js';

const LEVELS = ['log', 'info', 'warn', 'error', 'debug'];
const STDERR = new Set(['warn', 'error']); // where console writes each level
let installed = false;
const listeners = new Set();

/** fn(tenant, { at, s: 'out'|'err', text }) for every console call inside a tenant's context. */
export function onTenantLog(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function installTenantLogPrefix() {
  if (installed) return;
  installed = true;
  for (const level of LEVELS) {
    const original = console[level];
    const stream = STDERR.has(level) ? 'err' : 'out';
    console[level] = function tenantPrefixed(...args) {
      const name = requestContext.getStore()?.tenant?.name;
      if (!name) return original.apply(console, args);
      const text = util.format(...args);
      original.call(console, text.split('\n').map((line) => `[${name}] ${line}`).join('\n'));
      if (listeners.size) {
        const at = Date.now();
        for (const fn of listeners) {
          try { fn(name, { at, s: stream, text }); } catch { /* a listener never breaks logging */ }
        }
      }
    };
  }
}
