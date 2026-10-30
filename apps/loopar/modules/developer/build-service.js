'use strict';

/**
 * Shared build orchestrator: one build process at a time, behind a queue.
 * Jobs carry a `kind`: 'install' runs yarn install, 'activate' deploys the
 * build/staging snapshot, anything else runs the full `build` script.
 * Imported by both the Tenant Manager and App Manager controllers, which
 * share this module's singleton state.
 */

import { spawn } from 'child_process';
import crypto from 'node:crypto';

const queue = [];
let current = null;
let child = null;
let history = [];
let emitFn = null;

export function setEmitter(fn) {
  if (typeof fn === 'function') emitFn = fn;
}

export function snapshot() {
  return {
    build: current || { state: 'idle' },
    queue: queue.map((j) => ({ id: j.id, scope: j.scope })),
  };
}

export function getBuildStatus() {
  return { ...snapshot(), history };
}

function emit() {
  if (emitFn) emitFn('buildStatus', snapshot());
}

function runNext() {
  if (current || queue.length === 0) return;

  const job = queue.shift();
  current = { ...job, state: 'running', startedAt: Date.now() };
  emit();

  const isInstall = job.kind === 'install';
  const isActivate = job.kind === 'activate';

  // install → yarn; activate → deploy build/staging snapshot; else → full build.
  let cmd, args, tag;
  if (isInstall) {
    cmd = 'yarn';
    args = ['install', '--immutable', '--inline-builds'];
    tag = 'install';
  } else if (isActivate) {
    cmd = 'node';
    args = ['bin/build/activate-staging.js'];
    tag = 'activate';
  } else {
    cmd = 'yarn';
    args = ['build'];
    tag = 'build';
  }

  child = spawn(cmd, args, {
    cwd: job.cwd,
    env: {
      ...process.env,
      // Don't force NODE_ENV=production for install (Yarn must keep devDeps).
      ...(isInstall ? {} : { NODE_ENV: 'production' }),
      BUILD_INITIATOR: job.initiator || undefined,
      FORCE_COLOR: '0',
      TENANT_ID: undefined,
      TENANT_PATH: undefined,
      PORT: undefined,
      DOMAIN: undefined,
      HMR_PORT: undefined,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (c) => process.stdout.write(`[${tag}] ${c}`));
  child.stderr.on('data', (c) => process.stderr.write(`[${tag}] ${c}`));

  const finish = (patch) => {
    current = { ...current, ...patch, finishedAt: Date.now() };
    history.unshift(current);
    history = history.slice(0, 10);
    emit();            // emit the terminal state (completed/failed) so listeners react
    current = null;
    child = null;
    runNext();         // starts the next job (emits running) or leaves idle
  };

  child.on('exit', (code) =>
    finish({ state: code === 0 ? 'completed' : 'failed', exitCode: code })
  );
  child.on('error', (err) => finish({ state: 'failed', error: err.message }));
}

export function enqueueBuild({ scope = 'all', cwd, initiator } = {}) {
  const fullPending =
    (current && current.scope === 'all') || queue.some((j) => j.scope === 'all');

  if (scope === 'all') {
    queue.length = 0;
    if (current && current.scope === 'all') {
      return { queued: false, reason: 'ALREADY_RUNNING', ...snapshot() };
    }
  } else {
    if (fullPending) {
      return { queued: false, reason: 'COVERED_BY_FULL', ...snapshot() };
    }
    const dup =
      (current && current.scope === scope) ||
      queue.some((j) => j.scope === scope);
    if (dup) {
      return { queued: false, reason: 'ALREADY_QUEUED', ...snapshot() };
    }
  }

  const job = { id: crypto.randomUUID(), scope, cwd, initiator };
  queue.push(job);
  emit();
  runNext();
  return { queued: true, jobId: job.id, ...snapshot() };
}

export function enqueueInstall({ cwd, initiator } = {}) {
  const installPending =
    (current && current.kind === 'install') ||
    queue.some((j) => j.kind === 'install');
  if (installPending) {
    return { queued: false, reason: 'ALREADY_QUEUED', ...snapshot() };
  }
  const job = { id: crypto.randomUUID(), kind: 'install', scope: 'install', cwd, initiator };
  queue.push(job);
  emit();
  runNext();
  return { queued: true, jobId: job.id, ...snapshot() };
}

export function enqueueActivate({ cwd, initiator } = {}) {
  const pending =
    (current && current.kind === 'activate') ||
    queue.some((j) => j.kind === 'activate');
  if (pending) {
    return { queued: false, reason: 'ALREADY_QUEUED', ...snapshot() };
  }
  const job = { id: crypto.randomUUID(), kind: 'activate', scope: 'activate', cwd, initiator };
  queue.push(job);
  emit();
  runNext();
  return { queued: true, jobId: job.id, ...snapshot() };
}
