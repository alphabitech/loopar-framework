'use strict';

/**
 * Background jobs: long operations (installing or updating an app, a build)
 * run after the request has answered, and report their progress over
 * realtime instead of holding an HTTP request open.
 *
 *   const job = startJob({ kind: 'install', title: 'Install erp', key: 'install', run: async () => { ... } });
 *   // → answer the request with { job }: the client follows it.
 *
 * Inside `run` — and anything it calls, however deep (installer, nested
 * requirement installs) — jobStep / jobLog / jobProgress report to the
 * current job through an AsyncLocalStorage.
 *
 * Overall progress (`percent`, 0-100) never goes back. A step may set it
 * (`jobStep(msg, 40)`); `jobRange(40, 80)` maps the next jobProgress(done,
 * total) into that stretch, so a loop of documents fills only its phase and
 * the bar doesn't read 100% while later phases still run. Outside a job they do nothing,
 * so shared code (the setup wizard's install) reports nowhere and is unchanged.
 *
 * Events go to `user:<user>` of the job's tenant (action `job`): only the
 * user who started it, only in that tenant. State lives in memory: the core
 * runs one instance; a job lost to a restart reads as not found.
 * `key` is a lock per tenant: while a job with the same key runs, starting
 * another returns the running one (`alreadyRunning`).
 */

import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { RealtimeManager } from '../realtime/RealtimeManager.js';
import { loopar } from '../loopar.js';
import { debugCollector } from '../debug/collector.js';

const MAX_LOG = 2000;
const KEEP_FINISHED = 20;
const EMIT_EVERY_MS = 150;
const ACTION = 'job';

const jobs = new Map();
const jobContext = new AsyncLocalStorage();
// The exclusive (keyed) job running in each tenant: where reports land if
// some library along the way drops the async context.
const activeByTenant = new Map();

const now = () => Date.now();

/** What the client sees of a job. */
export function publicJob(job, { withLog = true } = {}) {
  if (!job) return null;
  const { id, kind, title, tenant, user, key, state, step, progress, percent, result, error, errorLink, startedAt, finishedAt, meta } = job;
  return {
    id, kind, title, tenant, user, key, state, step, progress, percent, result, error, errorLink, startedAt, finishedAt, meta,
    ...(withLog ? { log: job.log } : { logSize: job.log.length }),
  };
}

function emitNow(job, { trace = false } = {}) {
  job.lastEmit = now();
  job.emitTimer && clearTimeout(job.emitTimer);
  job.emitTimer = null;
  if (!job.tenant || !job.user) return;
  const room = `user:${job.user}`;
  // State and step changes leave a trace in the log (Debugger → Logs, "[jobs]").
  if (trace) {
    const listening = RealtimeManager.hasListeners(job.tenant, room);
    console.debug(`[jobs] ${job.title}: ${job.state}${job.step ? ` · ${job.step}` : ''} → ${job.tenant}/${room}${listening ? '' : ' (nobody listening)'}`);
  }
  // Only the lines added since the last event travel; the client appends them.
  const lines = job.log.slice(job.sentLines);
  job.sentLines = job.log.length;
  try {
    RealtimeManager.emit(job.tenant, room, ACTION, { ...publicJob(job, { withLog: false }), lines });
  } catch (e) {
    console.warn('[jobs] emit failed:', e?.message || e);
  }
}

/** Progress events are throttled; state changes and the end are sent at once. */
function emit(job, { force = false } = {}) {
  if (force) return emitNow(job, { trace: true });
  if (now() - (job.lastEmit || 0) >= EMIT_EVERY_MS) return emitNow(job);
  if (!job.emitTimer) job.emitTimer = setTimeout(() => emitNow(job), EMIT_EVERY_MS);
}

function prune() {
  const finished = [...jobs.values()]
    .filter((j) => !['queued', 'running'].includes(j.state))
    .sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0));
  for (const job of finished.slice(KEEP_FINISHED)) jobs.delete(job.id);
}

function addLine(job, message, level = 'info') {
  const text = String(message ?? '').trim();
  if (!text) return;
  job.log.push({ t: now(), level, message: text });
  if (job.log.length > MAX_LOG) {
    const cut = job.log.length - MAX_LOG;
    job.log.splice(0, cut);
    job.sentLines = Math.max(0, job.sentLines - cut);
  }
}

/** Overall percent: clamped to 0-99 while running, and never back. */
function setPercent(job, value) {
  let raw = Number(value) || 0;
  // Inside a span (one part of a bigger job), 0-100 maps onto that part.
  if (job.span) raw = job.span[0] + ((job.span[1] - job.span[0]) * raw) / 100;
  const v = Math.max(0, Math.min(99, Math.round(raw)));
  job.percent = Math.max(job.percent ?? 0, v);
}

/** A job record for work that runs elsewhere (a child process): see trackJob. */
function createJob({ kind, title, key = null, tenant, user, meta = null }) {
  const job = {
    id: crypto.randomUUID(),
    kind, title: title || kind, key,
    tenant: tenant ?? loopar.tenantId ?? null,
    user: user ?? loopar.auth?.user?.() ?? null,
    meta,
    state: 'queued',
    step: null,
    progress: null,
    percent: null,
    range: null,
    result: null,
    error: null,
    log: [],
    sentLines: 0,
    startedAt: null,
    finishedAt: null,
  };
  jobs.set(job.id, job);
  prune();
  return job;
}

function runningWithKey(tenant, key) {
  if (!key) return null;
  for (const job of jobs.values()) {
    if (job.tenant === tenant && job.key === key && ['queued', 'running'].includes(job.state)) return job;
  }
  return null;
}

/** Controls for a job's lifecycle (used by startJob and by external runners). */
function controls(job) {
  return {
    id: job.id,
    start() {
      job.state = 'running';
      job.startedAt = now();
      emit(job, { force: true });
    },
    step(message, percent = null) {
      job.step = String(message ?? '');
      // A new step closes the previous one's counter.
      job.progress = null;
      job.range = null;
      if (percent != null) setPercent(job, percent);
      addLine(job, message, 'step');
      emit(job, { force: true });
    },
    /**
     * The work that follows is one part of the job, worth `from`-`to` of the
     * bar: its own 0-100 percents (steps, ranges) are scaled into it. Used to
     * chain operations that each report a whole 0-100 (a cascade of uninstalls).
     */
    span(from, to) {
      job.span = [Number(from) || 0, Number(to) || 0];
      setPercent(job, 0);
      emit(job);
    },
    /** Runs `fn` once per job (e.g. one safety snapshot for a whole cascade); later calls get its result. */
    async once(key, fn) {
      job.onceResults ||= new Map();
      if (!job.onceResults.has(key)) job.onceResults.set(key, fn());
      return await job.onceResults.get(key);
    },
    range(from, to) {
      job.range = [Number(from) || 0, Number(to) || 0];
      setPercent(job, job.range[0]);
      emit(job);
    },
    log(message, level = 'info') {
      addLine(job, message, level);
      emit(job);
    },
    progress(done, total, label = null) {
      job.progress = { done: Number(done) || 0, total: Number(total) || 0, ...(label ? { label: String(label) } : {}) };
      const { done: d, total: t } = job.progress;
      if (t > 0) {
        const [from, to] = job.range || [0, 100];
        setPercent(job, from + ((to - from) * Math.min(d, t)) / t);
      }
      emit(job);
    },
    finish(result = null) {
      job.state = 'completed';
      job.percent = 100;
      job.result = result;
      job.finishedAt = now();
      emit(job, { force: true });
    },
    fail(error) {
      job.state = 'failed';
      job.error = error?.message || String(error || 'Failed');
      // Where to go from here, when the failure names it ({ label, to }).
      if (error?.link?.to) job.errorLink = { label: String(error.link.label || error.link.to), to: String(error.link.to) };
      addLine(job, job.error, 'error');
      job.finishedAt = now();
      emit(job, { force: true });
    },
  };
}

/**
 * Runs `run(ctl)` in the background, right after the caller returns. The
 * request's async context (tenant, user) carries over to the job.
 * Returns the public job (or the running one with the same `key`).
 */
export function startJob({ kind, title, key = null, meta = null, run }) {
  const tenant = loopar.tenantId ?? null;
  const running = runningWithKey(tenant, key);
  if (running) return { ...publicJob(running), alreadyRunning: true };

  const job = createJob({ kind, title, key, tenant, meta });
  const ctl = controls(job);

  setImmediate(() => {
    jobContext.run(ctl, async () => {
      if (key && tenant) activeByTenant.set(tenant, ctl);
      ctl.start();
      try {
        ctl.finish((await run(ctl)) ?? null);
      } catch (e) {
        // Recorded with its stack, origin and the job's trail (Debugger → Errors);
        // the log line points there instead of repeating the stack.
        const rec = debugCollector.recordError(e, { source: 'job' });
        console.error(`[jobs] ${job.kind} "${job.title}" failed: ${e?.message || e}${rec ? ` (error ${rec.id})` : ''}`);
        ctl.fail(e);
      } finally {
        if (activeByTenant.get(tenant) === ctl) activeByTenant.delete(tenant);
      }
    });
  });

  return publicJob(job);
}

/**
 * A job whose work runs outside this process' async flow (e.g. a spawned
 * build). The caller drives it: start / log / step / progress / finish / fail.
 */
export function trackJob({ kind, title, key = null, meta = null }) {
  const job = createJob({ kind, title, key, meta });
  return { job: publicJob(job), ...controls(job) };
}

export function getJob(id) {
  return jobs.get(id) || null;
}

/** Jobs of a tenant (optionally of one user), newest first. */
export function listJobs({ tenant = loopar.tenantId, user = null, active = false } = {}) {
  return [...jobs.values()]
    .filter((j) => j.tenant === tenant && (!user || j.user === user) && (!active || ['queued', 'running'].includes(j.state)))
    .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
}

/** May `user` follow this job? Its owner, or the Administrator, in the same tenant. */
export function canSeeJob(job, { tenant = loopar.tenantId, user = loopar.auth?.user?.() } = {}) {
  return !!job && job.tenant === tenant && (job.user === user || user === 'Administrator');
}

// ---- Reporting from inside a job (no-ops elsewhere) -------------------------

/** The job running in this async context, as the Debugger attributes work to it. */
export function currentJobInfo() {
  const ctl = jobContext.getStore();
  const job = ctl ? jobs.get(ctl.id) : null;
  return job ? { id: job.id, kind: job.kind, title: job.title, user: job.user, tenant: job.tenant } : null;
}
debugCollector.setJobResolver(currentJobInfo);

export const currentJob = () =>
  jobContext.getStore() || activeByTenant.get(loopar.tenantId ?? null) || null;
export const jobStep = (message, percent) => currentJob()?.step(message, percent);
export const jobRange = (from, to) => currentJob()?.range(from, to);
export const jobLog = (message, level) => currentJob()?.log(message, level);
export const jobProgress = (done, total, label) => currentJob()?.progress(done, total, label);
export const jobSpan = (from, to) => currentJob()?.span(from, to);
/** `fn` once per job; outside a job it always runs. */
export const jobOnce = async (key, fn) => {
  const job = currentJob();
  return job ? await job.once(key, fn) : await fn();
};
