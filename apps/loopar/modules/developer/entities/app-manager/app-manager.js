'use strict';

import fs from 'fs';
import path from 'path';
import { BaseDocument, loopar, fileManage, tenant } from 'loopar';
import { statusApp, getRemoteUrl } from './git-actions.js';
import { headSource, installedSources } from 'loopar/apps/core/modules/system/forms/installer/app-source.js';
import {
  isTemplateHeader, isTemplateHostTenant, belongsToOtherTenant, defaultDemoDomain, parseRequires,
} from 'loopar/apps/core/modules/system/forms/installer/template.js';

const PAGE_SIZE = 24;
const FRAMEWORK = 'loopar';
const isOn = (v) => v === true || v === 1 || v === '1' || v === 'true';

/**
 * App Manager: a read-only directory of the apps on this server (no table).
 * Rows come from apps/<folder>/installer.json plus this tenant's install
 * state; git status is read only for the rows of the page being shown.
 * Lifecycle and git actions live in the controller.
 */
export default class AppManager extends BaseDocument {
  constructor(props) {
    super(props);
  }

  /** Every app folder with an installer.json header, cheap fields only. */
  static async headers() {
    const appsRoot = loopar.makePath(loopar.pathRoot, 'apps');
    const rows = [];

    for (const dirent of await fs.promises.readdir(appsRoot, { withFileTypes: true })) {
      if (!dirent.isDirectory() || dirent.name.startsWith('.')) continue;
      const installer = fileManage.getConfigFile('installer', loopar.makePath('apps', dirent.name), null);
      const header = installer?.App;
      // A site created from a template is private to its tenant.
      if (!header?.name || belongsToOtherTenant(header)) continue;

      // Description and icon live in the App record the installer ships.
      const appDoc = installer.documents?.[`App:${header.name}`] || {};
      const installedApp = await loopar.getApp(header.name);
      const version = header.version || '0.0.1';
      const isTemplate = isTemplateHeader(header);
      const folderMismatch = dirent.name !== header.name;
      const hasGit = !folderMismatch && fs.existsSync(path.join(appsRoot, header.name, '.git'));
      const isFramework = header.name === FRAMEWORK && !hasGit;
      const templateHost = isTemplate && isTemplateHostTenant();

      rows.push({
        name: header.name,
        description: appDoc.description || installedApp?.description || '',
        icon: appDoc.icon || installedApp?.icon || '',
        autor: appDoc.autor || installedApp?.autor || '',
        version,
        installed: installedApp ? 1 : 0,
        installed_version: installedApp ? installedApp.version : version,
        is_template: isTemplate ? 1 : 0,
        has_website: isOn(appDoc.has_website ?? installedApp?.has_website) ? 1 : 0,
        requires: parseRequires(header.requires ?? appDoc.requires).filter((r) => r !== FRAMEWORK),
        git_repo: appDoc.git_repo || '',
        folder: dirent.name,
        folder_mismatch: folderMismatch,
        has_git: hasGit,
        is_framework: isFramework,
        template_host: templateHost,
        template_locked: isTemplate && process.env.NODE_ENV === 'production' && !templateHost,
        ...(templateHost ? { default_demo_domain: defaultDemoDomain(header.name) } : {}),
      });
    }

    // The framework first, then installed apps, then by name.
    return rows.sort((a, b) =>
      (b.is_framework - a.is_framework) || (b.installed - a.installed) || a.name.localeCompare(b.name));
  }

  /** Remote and working-tree state of the given rows (in place). */
  static async withGitStatus(rows) {
    const installed = installedSources();
    await Promise.all(rows.map(async (app) => {
      // What this tenant's database was installed from (sites/<tenant>/config/app-sources.json).
      app.installed_source = installed[app.name] || null;
      if (!app.has_git && !app.is_framework) {
        app.remote_url = '';
        app.repo_status = null;
        app.source = null;
        return;
      }
      // Where the code is: its commit, and the version tag when pinned to one.
      app.source = await headSource(app.name).catch(() => null);
      try {
        app.remote_url = (await getRemoteUrl(app.name)) || app.git_repo || '';
      } catch {
        app.remote_url = app.git_repo || '';
      }
      try {
        app.repo_status = await statusApp(app.name);
      } catch {
        app.repo_status = null;
      }
    }));
    return rows;
  }

  /** Search: text in name/description, plus the switches of the search form. */
  static filter(rows, q) {
    if (!q) return rows;
    const query = typeof q === 'string' ? { name: q } : q;
    const term = String(query.q || query.name || '').trim().toLowerCase();
    return rows.filter((r) =>
      (!term || r.name.toLowerCase().includes(term) || r.description.toLowerCase().includes(term)) &&
      (!isOn(query.installed) || r.installed) &&
      (!isOn(query.is_template) || r.is_template));
  }

  /** The dependency graph: every app (unfiltered), what it requires, and its state. */
  static graph(rows) {
    // The framework too: every app depends on it (the graph's root).
    return rows
      .map(({ name, description, icon, installed, is_framework, is_template, template_locked, requires, folder_mismatch }) =>
        ({ name, description, icon, installed, is_framework, is_template, template_locked, requires, folder_mismatch }));
  }

  async getList({ fields = null, q = null, rowsOnly = false } = {}) {
    const entityName = this.__ENTITY__.name;
    const all = await AppManager.headers();
    const rows = AppManager.filter(all, q);

    const totalRecords = rows.length;
    const totalPages = Math.max(1, Math.ceil(totalRecords / PAGE_SIZE));
    const page = Math.min(Math.max(1, loopar.getPage(entityName) || 1), totalPages);
    const pageRows = await AppManager.withGitStatus(rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE));

    return Object.assign((rowsOnly ? {} : await this.__meta__()), {
      labels: this.getFieldListLabels(),
      fields: fields || this.getFieldListNames(),
      rows: pageRows,
      dependencies: AppManager.graph(all),
      // Where code work (git, versions, Get App) runs: the other tenants point there.
      control_plane: tenant.controlPlaneTenants().map((name) => ({
        name, domain: tenant.readTenant(name)?.domain || `${name}.localhost`,
      })),
      pagination: { page, pageSize: PAGE_SIZE, totalPages, totalRecords, sortBy: 'name', sortOrder: 'asc', __ENTITY__: entityName },
      q,
    });
  }

  async save() {
    loopar.throw({ code: 405, message: 'App Manager lists the apps on disk: edit the App instead.' });
  }

  async delete() {
    loopar.throw({ code: 405, message: 'App Manager lists the apps on disk: uninstall the App instead.' });
  }
}
