
'use strict';

import 'loopar/bin/pm2-home.js';
import {BaseController, loopar} from 'loopar';
import pm2 from 'pm2';
import { coreEnv, setCoreMode } from 'loopar/core/config/core-config.js';
import { distIsReady } from 'loopar/core/server/runtime-mode.js';
import { enqueueBuild, enqueueInstall, enqueueActivate, getBuildStatus, setEmitter } from '../../build-service.js';

setEmitter((event, payload) => loopar.emit(event, payload));

const CORE_PROCESS_NAME = 'loopar-core';

export default class TenantManagerController extends BaseController {
  unRestrictedActions = ["list", "create", "update"]
  constructor(props){
    super(props);
  }

  async beforeAction(){
    const test = await super.beforeAction();

    const isControlPlane = ["1", "true"].includes(String(process.env.CONTROL_PLANE))
      || ["loopar", "dev", "cloud"].includes(loopar.tenantId);

    if(!test || !isControlPlane) loopar.throw({ status: 403, title: 'Forbidden', message: 'Access restricted' })
  }

  async getTenant(name = this.name) {
    return await loopar.getDocument("Tenant Manager", name, null);
  }

  async actionCoreStatus() {
    return { status: 200, success: true, mode: coreEnv() };
  }

  async actionCoreDev()  { return this.#applyCoreMode('development'); }
  async actionCoreProd() { return this.#applyCoreMode('production'); }

  #applyCoreMode(mode) {
    if (mode === 'production' && !distIsReady()) {
      return loopar.throw('No production build found. Deploy (or run `yarn build`) before switching to production.');
    }
    const applied = setCoreMode(mode).nodeEnv;

    // Deferred restart so THIS response reaches the browser before the core
    // reloads (the Desk itself is served by the core). The daemon performs the
    // restart, so the current process can safely schedule its own.
    setTimeout(() => {
      try {
        pm2.connect((err) => {
          if (err) return;
          pm2.restart(CORE_PROCESS_NAME, () => { try { pm2.disconnect(); } catch (_) {} });
        });
      } catch (_) { /* best-effort */ }
    }, 600);

    return this.success(`Core → ${applied}. Restarting… (tenants briefly disconnect)`, {
      notify: { type: 'warning' },
    });
  }

  /** Destination for opening a tenant from the list (desk or install link). */
  async actionOpenUrl() {
    const tenant = await this.getTenant();
    if (!tenant) loopar.throw({ code: 404, message: `Tenant ${this.name}: not found` });
    return { status: 200, success: true, url: await tenant.openUrl() };
  }

  async actionStart(){
    return await this.makeAction("start");
  }

  async actionStop(){
    return await this.makeAction("stop");
  }

  async actionRestart(){
    return await this.makeAction("restart");
  }

  async actionReload(){
    return await this.makeAction("reload");
  }

  async actionActivate() {
    const res = enqueueActivate({
      cwd: loopar.pathRoot,
      initiator: loopar.tenantId,
    });
    return {
      status: 200,
      success: true,
      build: res.build,
      queue: res.queue,
      notify: {
        type: res.queued ? 'info' : 'warning',
        message: res.queued
          ? 'Activating latest build (deploying staging snapshot)…'
          : 'An activation is already in progress.',
      },
    };
  }

  async actionInstall() {
    const res = enqueueInstall({
      cwd: loopar.pathRoot,
      initiator: loopar.tenantId,
    });
    return {
      status: 200,
      success: true,
      build: res.build,
      queue: res.queue,
      notify: {
        type: res.queued ? 'info' : 'warning',
        message: res.queued
          ? 'Installing dependencies (yarn install)…'
          : 'An install is already in progress.',
      },
    };
  }

  async actionBuild() {
    const scope =
      (this.body && this.body.app) ||
      (this.query && this.query.app) ||
      'all';

    const res = enqueueBuild({
      scope,
      cwd: loopar.pathRoot,
      initiator: loopar.tenantId,
    });

    let type = 'info';
    let message;
    if (res.queued) {
      message = scope === 'all'
        ? "Build started — you'll be notified when it finishes."
        : `Build for "${scope}" queued — you'll be notified when it finishes.`;
    } else {
      type = 'warning';
      message = {
        ALREADY_RUNNING: 'A build is already in progress.',
        ALREADY_QUEUED: `A build for "${scope}" is already queued.`,
        COVERED_BY_FULL: 'A full build is already in progress; it covers this app.',
      }[res.reason] || 'A build is already in progress.';
    }

    return {
      status: 200,
      success: true,
      build: res.build,
      queue: res.queue,
      notify: { type, message },
    };
  }

  async actionBuildStatus() {
    return {
      status: 200,
      success: true,
      ...getBuildStatus(),
    };
  }

  async makeAction(action){
    const tenant = await this.getTenant();
    const r = await tenant[action]();

    return this.success(
      r ? `${this.name}.${action} completed successfully` :
        `${this.name}.${action} failed`,
      { 
        notify: { 
          type: r ? ["stop", "restart"].includes(action) ? "warning" : "success" : "error" 
        }
      }
    )
  }
}