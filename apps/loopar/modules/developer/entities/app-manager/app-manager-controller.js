
'use strict';

import { SystemController, loopar } from 'loopar';

import { pullApp, pushApp, commitApp, discardApp, publishApp, statusApp, getDiff, cloneRepo } from './git-actions.js';
import { enqueueBuild, setEmitter } from '../../build-service.js';
import { listGitAccounts } from './git-accounts.js';
import AppManager from './app-manager.js';
import { createMigration, pendingMigrations } from 'loopar/core/document/app-migrations.js';
import WorkspaceController from 'loopar/core/controller/workspace-controller.js';
import { startJob, getJob, listJobs, canSeeJob, publicJob, jobStep, jobSpan } from 'loopar/core/jobs/jobs.js';
import { publishTemplateDemo, defaultDemoDomain, installedDependents } from 'loopar/apps/core/modules/system/forms/installer/template.js';

setEmitter((event, payload) => loopar.emit(event, payload));

const LIST_URL = '/desk/App Manager/list';

/**
 * App Manager is a virtual entity (app-manager.js builds its rows from the
 * apps on disk): `list` is the inherited one. Install/update/uninstall come
 * from SystemController; git and template actions are below.
 */
export default class AppManagerController extends SystemController {
  // SystemController's public setup actions (the install wizard) must not
  // answer here: a public action wins over the action of the same name, so
  // `job` would serve only setup jobs (404 for app jobs) and `install` /
  // `update` would run the wizard's flow instead of the App Manager's.
  static publicActions = [];
  static revokedPublicActions = ['testConnection', 'install', 'update', 'reinstall', 'job', 'claimLogin'];

  constructor(props) {
    super(props);
  }

  redirect(route = LIST_URL) {
    return super.redirect(route);
  }

  /** Old links (/desk/App Manager/view) land on the list. */
  async actionView() {
    return this.redirect(LIST_URL);
  }

  /** The apps as a list entry (SystemController defaults to the installer form). */
  async actionList() {
    this.client = 'list';
    this.entry = 'list';
    const result = await super.actionList();
    // A refresh (preloaded) answers with rows only: the graph needs its apps too.
    if (this.preloaded == true) result.dependencies = AppManager.graph(await AppManager.headers());
    return result;
  }

  /**
   * Apps aren't opened as records here (editing lives on the cards): a page
   * visit — a GET, or the desk's navigation fetch, which is a POST carrying
   * `workspace` — lands on the list. Other POSTs stay SystemController's.
   */
  async actionUpdate() {
    const isGet = ['GET', 'HEAD'].includes(String(this.method || '').toUpperCase());
    if (isGet || this.query?.workspace) return this.redirect(LIST_URL);
    return await super.actionUpdate();
  }

  // ---- Install / update / uninstall as background jobs ----------------------
  // The request answers at once with the job; its progress travels over
  // realtime (core/jobs). Integrity checks make installs long: nothing waits
  // on an HTTP request any more, and a closed tab doesn't stop the work.

  async actionInstall() {
    return await this.#appJob('install');
  }

  async actionReinstall() {
    return await this.#appJob('update');
  }

  async actionUninstall() {
    return await this.#appJob('uninstall');
  }

  /**
   * A new, empty data migration for an app (development): the file to fill
   * in with what to do with the existing data. It runs on each tenant at the
   * app's next update (core/document/app-migrations.js).
   */
  async actionNewMigration() {
    await this.assertCanManageInstalls();
    const appName = this.#requireAppName();
    const description = String(this.body?.description || '').trim();
    if (!description) loopar.throw({ status: 400, title: 'Data migration', message: 'Describe what the migration does.' });
    const created = createMigration(appName, { description });
    return {
      file: `apps/${appName}/migrations/${created.name}`,
      notice: `Created apps/${appName}/migrations/${created.name}: write its up() and ship it with the app's next version.`,
    };
  }

  /** The app's migrations this tenant hasn't applied yet. */
  async actionMigrations() {
    await this.assertCanManageInstalls();
    return { pending: await pendingMigrations(this.#requireAppName()) };
  }

  /** The desk's menu after an app job: the page redraws its sidebar without reloading. */
  async actionDeskMenu() {
    return await WorkspaceController.deskMenu();
  }

  /** The installed apps that need this one (uninstall order): the client offers the cascade. */
  async actionDependents() {
    await this.assertCanManageInstalls();
    return { dependents: await installedDependents(this.#requireAppName()) };
  }

  async #appJob(action) {
    await this.assertCanManageInstalls();
    const appName = this.#requireAppName();
    const data = { ...(this.data || {}) };
    const title = { install: 'Install', update: 'Update', uninstall: 'Uninstall' }[action];

    // Uninstalling an app others need: only as an explicit cascade (the
    // client asked, listing them), never by surprise.
    const dependents = action === 'uninstall' ? await installedDependents(appName) : [];
    const cascade = dependents.length > 0 && [true, 1, '1', 'true'].includes(data.cascade);
    if (dependents.length && !cascade) {
      loopar.throw({
        status: 409, code: 'APP_HAS_DEPENDENTS', title: 'Uninstall',
        message: `"${appName}" can't be uninstalled: ${dependents.map((d) => `"${d}"`).join(', ')} ${dependents.length > 1 ? 'require' : 'requires'} it.`,
      });
    }

    const job = startJob({
      kind: 'app',
      title: cascade
        ? `${title} ${appName} and ${dependents.length} dependent app${dependents.length > 1 ? 's' : ''}`
        : `${title} ${appName}`,
      // One install/update/uninstall at a time per tenant.
      key: 'app-lifecycle',
      meta: { app: appName, action, ...(cascade ? { cascade: dependents } : {}) },
      run: async () => {
        if (action === 'uninstall') {
          // Dependents first (deepest first), the app last; each its share of the bar.
          const order = [...dependents, appName];
          for (const [i, name] of order.entries()) {
            if (order.length > 1) jobSpan((i * 100) / order.length, ((i + 1) * 100) / order.length);
            const app = await loopar.getDocument('App', name);
            await app.unInstall();
          }
        } else {
          await this.unInstallApp(appName, data, action === 'update');
        }
        jobStep(`${title} of ${appName} finished`);
        // The framework itself: the browser reloads to pick up the new code.
        return { app: appName, action, reload: appName === 'loopar' };
      },
    });

    return { job };
  }

  /** A background job of this tenant: its owner or the Administrator may follow it. */
  async actionJob() {
    const job = getJob(this.query?.id || this.body?.id);
    if (!canSeeJob(job)) {
      loopar.throw({ code: 404, title: 'Job', message: 'This job is no longer available (it may have ended before a restart).' });
    }
    return { job: publicJob(job) };
  }

  /** The user's jobs still running in this tenant (the list reopens their progress). */
  async actionJobs() {
    const user = loopar.auth.user();
    return { jobs: listJobs({ user, active: true }).map((j) => publicJob(j, { withLog: false })) };
  }

  /**
   * Publish demo (template host tenant only): installs the template as it is,
   * when it isn't yet, and serves it on its own domain. Updating the template
   * (pull + Update) updates the demo.
   */
  async actionPublishDemo() {
    const { template, domain } = { ...(this.query || {}), ...(this.body || {}) };
    const host = String(domain || '').trim().toLowerCase();
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$|^[a-z0-9.-]+\.localhost$/.test(host)) {
      loopar.throw({ status: 400, title: 'Publish demo', message: `Enter the demo's domain (e.g. ${defaultDemoDomain(template)}).` });
    }
    await publishTemplateDemo(template, host);
    return this.success(`Demo of "${template}" published on ${host}.`);
  }

  /** Get App: clones with the user's Git Account so private repos work on servers too. */
  async actionClone() {
    const { git_repo } = this.body || {};
    if (!git_repo || !String(git_repo).trim()) loopar.throw('Enter the repository URL of the app.');

    const installer = await loopar.newDocument('Installer');
    if (await installer.clone(String(git_repo).trim(), cloneRepo)) {
      return this.redirect();
    }
  }

  async actionPull() {
    const app_name = this.#requireAppName();
    const result = await pullApp(app_name);

    const restartNote = result.needs_restart
      ? ' Reload the core to apply (Deploy reloads it).'
      : '';
    const changesNote = result.files_changed
      ? ` ${result.files_changed} file(s) changed.`
      : ' Already up to date.';

    let buildNote = '';
    const buildOnPull = !['0', 'false'].includes(String(process.env.LOOPAR_BUILD_ON_PULL ?? '1'));
    const changed = result.files_changed > 0 || result.needs_restart;

    if (buildOnPull && changed) {
      const q = enqueueBuild({
        scope: 'all',
        cwd: loopar.pathRoot,
        initiator: loopar.tenantId,
      });
      result.build_queued = q.queued;
      result.build_job = q.job || null;
      buildNote = q.queued
        ? ' Full build started.'
        : ' A build is already in progress.';
    }

    return await this.success(result, {
      notify: {
        type: 'success',
        message: `Pulled ${app_name}.${changesNote}${restartNote}${buildNote}`
      }
    });
  }

  async actionPush() {
    const app_name = this.#requireAppName();
    const result = await pushApp(app_name);

    if (result.noop) {
      return await this.success(result, { notify: { type: 'info', message: result.message } });
    }

    return await this.success(result, {
      notify: {
        type: 'success',
        message: `Pushed ${app_name} (${result.pushed} commit${result.pushed === 1 ? '' : 's'}).`
      }
    });
  }

  async actionCommit() {
    const app_name = this.#requireAppName();
    const message = (this.body && this.body.message) || (this.query && this.query.message);

    const result = await commitApp(app_name, message);

    if (result.noop) {
      return await this.success(result, { notify: { type: 'info', message: result.message } });
    }

    return await this.success(result, {
      notify: {
        type: 'success',
        message: `Committed ${app_name} (${result.files_committed} file${result.files_committed === 1 ? '' : 's'}). Push when ready.`
      }
    });
  }


  async actionDiscard() {
    const app_name = this.#requireAppName();
    const result = await discardApp(app_name);

    await this.unInstallApp(app_name, {}, true);

    return await this.success(result, {
      notify: { type: 'warning', message: result.message }
    });
  }

  async actionPublish() {
    const app_name = this.#requireAppName();
    const input = { ...(this.query || {}), ...(this.body || {}) };

    const result = await publishApp(app_name, {
      account: input.account,
      owner: input.owner,
      repo: input.repo,
      isPrivate: input.private === undefined ? true : loopar.utils.trueValue(input.private),
      remoteUrl: input.remote_url,
      message: input.message || 'Initial commit',
    });

    return await this.success(result, {
      notify: {
        type: 'success',
        message: `${result.created ? 'Created and published' : 'Published'} ${app_name} → ${result.remote_url} (${result.branch}).`
      }
    });
  }

  /** The acting user's git accounts (no tokens) for the Publish dialog. */
  async actionGitAccounts() {
    return { accounts: await listGitAccounts() };
  }

  async actionDiff() {
    return await getDiff(this.#requireAppName());
  }

  async actionStatus() {
    return await statusApp(this.#requireAppName());
  }

  #requireAppName() {
    const app_name = (this.body && this.body.app_name) || (this.query && this.query.app_name);
    if (!app_name) loopar.throw("app_name is required");
    return app_name;
  }
}
