'use strict';

import { BaseDocument, fileManage, loopar } from 'loopar';
import { buildInstaller } from './builder.js';
import { buildThemeCSS } from '../system-settings/theme-css.js';
import fs from 'fs';
import path from 'path';

export default class App extends BaseDocument {
  constructor(props) {
    super(props);
  }

  async save(makeStructure = true) {
    const args = arguments[0] || {};
    const isNew = this.__IS_NEW__;

    if (makeStructure && !loopar.installing) {
      await this.validateAppVersion();
    }

    this.autor = (!this.autor || this.autor === '')
      ? loopar.currentUser.email
      : this.autor;
    this.version = (!this.version || this.version === '')
      ? '0.0.1'
      : this.version;

    await super.save(args);
    this.writeTheme();

    if (makeStructure) await this.makeAppStructure();

    if (isNew) loopar.setApp({ [this.name]: this.version });

    await loopar.build();

    return true;
  }

  /**
   * A web app may carry its own theme (served on its site domains instead of
   * the tenant theme). Stored per tenant: sites/<tenant>/themes/<app>.css.
   */
  writeTheme() {
    const file = loopar.makePath(loopar.tenantPath, 'themes', `${this.name}.css`);
    const css = buildThemeCSS(this.theme);
    if (css) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, css, 'utf8');
    } else if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  }

  async validateAppVersion() {
    if (this.__IS_NEW__) return;

    const installerData = fileManage.getConfigFile(
      'installer',
      loopar.makePath('apps', this.name),
      null
    );
    const physical = installerData?.App?.version;
    if (!physical) return;

    const installedApp = await loopar.getApp(this.name);
    const installed = installedApp?.version;
    if (!installed) return;

    if (this.#compareVersion(physical, installed) > 0) {
      loopar.throw(
        `Cannot save "${this.name}": ` +
        `physical version (${physical}) is ahead of installed (${installed}). ` +
        `Run <a href="/desk/App Manager/view">Update</a> first to sync the database.`
      );
    }
  }


  #compareVersion(a, b) {
    const pa = (a || '0.0.0').split('.').map(n => parseInt(n, 10) || 0);
    const pb = (b || '0.0.0').split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < 3; i++) {
      if (pa[i] !== pb[i]) return pa[i] - pb[i];
    }
    return 0;
  }

  async makeAppStructure() {
    if (loopar.installing) return;

    await fileManage.makeFolder(loopar.makePath('apps', this.name), 'modules');
    await fileManage.makeFolder(loopar.makePath('apps', this.name), 'public', 'uploads', 'thumbnails');

    if (!await loopar.db.count('Module', this.name)) {
      const newModule = await loopar.newDocument('Module', {
        name: this.name,
        description: this.name,
        app_name: this.name,
        icon: this.icon,
        in_sidebar: 1,
      });
      await newModule.save();
    }

    await fileManage.makeClass(loopar.makePath('apps', this.name), 'installer', {
      IMPORTS: { CoreInstaller: 'loopar' },
      EXTENDS: 'CoreInstaller',
    });

    this.__IS_NEW__ = false;
    await this.bump('patch');
  }

  async bump(type) {
    const version = this.version.split('.');

    switch (type) {
      case 'major':
        version[0] = parseInt(version[0]) + 1;
        version[1] = 0;
        version[2] = 0;
        break;
      case 'minor':
        version[1] = parseInt(version[1]) + 1;
        version[2] = 0;
        break;
      case 'patch':
        version[2] = parseInt(version[2]) + 1;
        break;
    }

    this.version = version.join('.');
    await this.save(false);
    await this.buildInstaller();

    return true;
  }

  async buildInstaller() {
    await buildInstaller({ app: this.name, version: this.version });
  }

  async setOnInstall() {
    await fileManage.setConfigFile('installed-apps', {
      ...fileManage.getConfigFile('installed-apps'),
      [this.name]: this.version,
    });
    return true;
  }

  async unInstall() {
    await loopar.unInstallApp(this.name);
    const installedApps = fileManage.getConfigFile('installed-apps');
    delete installedApps[this.name];
    fileManage.setConfigFile('installed-apps', installedApps);
    return await loopar.build();
  }
}
