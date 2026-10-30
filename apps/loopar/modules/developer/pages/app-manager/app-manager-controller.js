
'use strict';

import { SystemController, loopar, fileManage } from 'loopar';
import fs from "fs";
import path from 'path';

import { pullApp, pushApp, commitApp, discardApp, publishApp, statusApp, getDiff, getRemoteUrl, getCwdForApp } from './git-actions.js';
import { enqueueBuild, setEmitter } from '../../build-service.js';
import { listGitAccounts } from './git-accounts.js';

setEmitter((event, payload) => loopar.emit(event, payload));

export default class AppManagerController extends SystemController {
  constructor(props) {
    super(props);

    this.action !== 'view' && this.method === 'GET' && this.redirect('view');
  }

  redirect(route = '/desk/App Manager/view') {
    return super.redirect(route);
  }

  async actionView() {
    this.client = "view";
    this.entry = "list"; // a grid of app cards, not a document view
    const appsList = [];
    const apps = await loopar.getList('App', { fields: ["*"] });
    const dir = await fs.promises.opendir(loopar.makePath(loopar.pathRoot, "apps"));

    for await (const dirent of dir) {
      if (fs.lstatSync(path.resolve(loopar.makePath(loopar.pathRoot, "apps", dirent.name))).isDirectory()) {
        const installerData = fileManage.getConfigFile('installer', loopar.makePath("apps", dirent.name), []);

        const app = installerData.App;

        if (app) {
          const installedApp = await loopar.getApp(app.name);

          app.installed = !!installedApp;
          app.version ??= '0.0.1';
          app.installed_version = installedApp ? installedApp.version : app.version;
          app.valid_repo = loopar.gitRepositoryIsValid(app.git_repo);

          // Every app operation resolves apps/<App.name>; a folder named
          // differently (e.g. cloned under the repo name) is unmanageable.
          app.folder = dirent.name;
          app.folder_mismatch = dirent.name !== app.name;

          const ownGitPath = loopar.makePath(loopar.pathRoot, 'apps', app.name, '.git');
          app.has_git = !app.folder_mismatch && fs.existsSync(ownGitPath);
          app.is_framework = (app.name === 'loopar' && !app.has_git);

          appsList.push(app);
        }
      }
    }

    await Promise.all(appsList.map(async (app) => {
      if (!app.has_git && !app.is_framework) {
        app.remote_url = '';
        app.repo_status = null;
        return;
      }
      try {
        const liveUrl = await getRemoteUrl(app.name);
        app.remote_url = liveUrl || app.git_repo || '';
      } catch {
        app.remote_url = app.git_repo || '';
      }
      try {
        app.repo_status = await statusApp(app.name);
      } catch {
        app.repo_status = null;
      }
    }));

    if(this.preloaded == 'true') {
      return {
        instance: this.getInstance(),
        rows: appsList
      }
    }

    //apps.rows = appsList;

    apps.Entity.name = "App Manager";


    return await this.render(apps, {rows: appsList});
  }

  async actionClone() {
    const { git_repo } = this.body || {};

    const model = await loopar.newDocument('App Manager');
    Object.assign(model, { git_repo });

    if (await model.clone()) {
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
