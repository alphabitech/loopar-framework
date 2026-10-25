'use strict';

import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { tenantRegistry } from '../server/tenant-registry.js';
import { requestContext } from '../server/router/request-context.js';
import { loopar, getTenantInstance } from '../loopar.js';

/**
 * Scheduled jobs for every active tenant, run by the core process.
 *
 * An app declares its jobs in `apps/<app>/jobs.js`:
 *
 *   export default [
 *     { name: 'document-expiry', label: 'Document expiry alerts',
 *       schedule: { every: 'daily', at: '06:00' },          // hourly | daily | weekly (+ on: 'mon')
 *       run: async () => 'summary shown in the job log' },
 *   ];
 *
 * Each job runs inside its tenant's context (the `loopar` proxy resolves to
 * the tenant), only for installed apps, never twice at once. Only tenants
 * already connected to the core are visited (the scheduler never boots a
 * tenant on its own): a job missed while its tenant was down runs on the
 * first tick after the tenant's next request. State lives in
 * the core entity `Scheduled Job` (one row per tenant job: enabled, last and
 * next run, result), where an admin can disable a job or run it now.
 * Times are server-local. Single-process by design (instances:1): a cluster
 * would need a DB lock per job before `#run`.
 */

const TICK_MS = 60_000;
const ENTITY = 'Scheduled Job';
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const pad = (n) => String(n).padStart(2, '0');
const dbTime = (d) => d ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` : null;
const parseDbTime = (v) => {
  if (!v) return null;
  const d = new Date(String(v).replace(' ', 'T'));
  return isNaN(d) ? null : d;
};

/** `{ every, at, on }` → readable text, e.g. "weekly on mon at 05:00". */
export function describeSchedule(s = {}) {
  return [s.every || 'daily', s.on && `on ${s.on}`, s.every !== 'hourly' && `at ${s.at || '00:00'}`].filter(Boolean).join(' ');
}

/** First run strictly after `from` for a schedule. */
export function nextRun(schedule = {}, from = new Date()) {
  const every = schedule.every || 'daily';
  if (every === 'hourly') {
    const d = new Date(from);
    d.setMinutes(Number(schedule.minute ?? 0), 0, 0);
    if (d <= from) d.setHours(d.getHours() + 1);
    return d;
  }

  const [h, m] = String(schedule.at || '00:00').split(':').map(Number);
  const d = new Date(from);
  d.setHours(h || 0, m || 0, 0, 0);
  if (every === 'weekly') {
    const target = Math.max(0, DAYS.indexOf(String(schedule.on || 'mon').slice(0, 3).toLowerCase()));
    d.setDate(d.getDate() + ((target - d.getDay() + 7) % 7));
    if (d <= from) d.setDate(d.getDate() + 7);
    return d;
  }
  if (d <= from) d.setDate(d.getDate() + 1);
  return d;
}

class Scheduler {
  #timer = null;
  #running = new Set();
  #ticking = false;

  start() {
    if (this.#timer || process.env.LOOPAR_SCHEDULER === 'off') return;
    this.#timer = setInterval(() => this.tick(), TICK_MS);
    this.#timer.unref?.();
    setTimeout(() => this.tick(), 15_000).unref?.();
    console.log('[scheduler] started');
  }

  stop() {
    clearInterval(this.#timer);
    this.#timer = null;
  }

  /** Runs every due job of every active tenant. */
  async tick() {
    if (this.#ticking) return;
    this.#ticking = true;
    try {
      for (const tenant of tenantRegistry.all()) {
        if (tenant.status !== 'active' || tenant.suspended || !getTenantInstance(tenant.name)) continue;
        try {
          await this.#inTenant(tenant, () => this.#tickTenant());
        } catch (e) {
          console.warn(`[scheduler] ${tenant.name}: ${e.message}`);
        }
      }
    } finally {
      this.#ticking = false;
    }
  }

  async #inTenant(tenant, fn) {
    return await requestContext.run({ tenant }, fn);
  }

  /** Jobs the installed apps of the current tenant declare. */
  async #jobs() {
    if (!loopar.__installed__ || !loopar.getRef(ENTITY)) return [];
    const jobs = [];
    for (const app of Object.keys(loopar.installedApps || {})) {
      const file = path.join(loopar.pathRoot, 'apps', app, 'jobs.js');
      if (!fs.existsSync(file)) continue;
      try {
        const mod = await import(pathToFileURL(file).href);
        for (const job of mod.default || []) {
          if (job?.name && typeof job.run === 'function') jobs.push({ ...job, app, key: `${app}.${job.name}` });
        }
      } catch (e) {
        console.warn(`[scheduler] ${app}/jobs.js: ${e.message}`);
      }
    }
    return jobs;
  }

  async #state(job) {
    let row = await loopar.db.getDoc(ENTITY, job.key, ['name', 'enabled', 'next_run_at', 'schedule']);
    const schedule = describeSchedule(job.schedule);
    if (!row) {
      await loopar.db.insertRow(ENTITY, {
        name: job.key, app: job.app, job: job.name, label: job.label || job.name, schedule,
        enabled: 1, next_run_at: dbTime(nextRun(job.schedule)),
      });
      row = await loopar.db.getDoc(ENTITY, job.key, ['name', 'enabled', 'next_run_at', 'schedule']);
    } else if (row.schedule !== schedule) {
      // The app changed the schedule: recompute the next run.
      await loopar.db.updateRow(ENTITY, job.key, { schedule, next_run_at: dbTime(nextRun(job.schedule)) });
      row = { ...row, schedule, next_run_at: dbTime(nextRun(job.schedule)) };
    }
    return row;
  }

  async #tickTenant() {
    const now = new Date();
    for (const job of await this.#jobs()) {
      const row = await this.#state(job);
      if (![1, '1', true].includes(row.enabled)) continue;
      const due = parseDbTime(row.next_run_at);
      if (due && due > now) continue;
      await this.#run(job);
    }
  }

  async #run(job) {
    const lock = `${loopar.tenantId}|${job.key}`;
    if (this.#running.has(lock)) return { status: 'Running' };
    this.#running.add(lock);
    const started = new Date();
    await loopar.db.updateRow(ENTITY, job.key, { last_status: 'Running', last_run_at: dbTime(started) });

    let status = 'Success', result = '';
    try {
      const out = await job.run();
      result = typeof out === 'string' ? out : out == null ? '' : JSON.stringify(out);
    } catch (e) {
      status = 'Failed';
      result = e?.message || String(e);
      console.error(`[scheduler] ${loopar.tenantId} ${job.key} failed:`, e);
    } finally {
      this.#running.delete(lock);
    }

    await loopar.db.updateRow(ENTITY, job.key, {
      last_status: status,
      last_result: String(result).slice(0, 2000),
      last_duration_ms: Date.now() - started.getTime(),
      next_run_at: dbTime(nextRun(job.schedule, new Date())),
    });
    return { status, result };
  }

  /** Runs one job of the current tenant now (the `Scheduled Job` "Run now" action). */
  async runNow(key) {
    const job = (await this.#jobs()).find(j => j.key === key);
    if (!job) loopar.throw(`Job ${key} is not declared by any installed app.`);
    await this.#state(job);
    return await this.#run(job);
  }
}

export const scheduler = new Scheduler();
