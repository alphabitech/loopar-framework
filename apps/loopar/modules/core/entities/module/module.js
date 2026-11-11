'use strict'

import { BaseDocument, fileManage, loopar } from "loopar";

export default class Module extends BaseDocument {
  constructor(props) {
    super(props);
  }

  /**
   * Submodules are one level deep: a module with a parent can't be a parent
   * itself, and both belong to the same app.
   */
  async validateParent() {
    if (!this.parent_module) return;

    if (this.parent_module === this.name) {
      loopar.throw("A module can't be its own parent.");
    }

    const [parent] = await loopar.db.getAll("Module", ["name", "app_name", "parent_module"], { name: this.parent_module });
    if (!parent) loopar.throw(`Parent module "${this.parent_module}" does not exist.`);
    if (parent.parent_module) {
      loopar.throw(`"${parent.name}" is already a submodule of "${parent.parent_module}": submodules are one level deep.`);
    }
    if (parent.app_name !== this.app_name) {
      loopar.throw(`Parent module "${parent.name}" belongs to another app (${parent.app_name}).`);
    }
    if (!this.__IS_NEW__ && await loopar.db.count("Module", { parent_module: this.name })) {
      loopar.throw(`"${this.name}" has submodules: it can't become a submodule itself.`);
    }
  }

  async save() {
    if (!loopar.installing) await this.validateParent();
    await super.save(arguments[0] || {});
    if (loopar.installing) return;

    await this.makeModuleRoute();
    await loopar.build();
  }

  appPath() {
    return loopar.makePath('apps', this.app_name);
  }

  modulePath() {
    return loopar.makePath(this.appPath(), 'modules');
  }

  async makeModuleRoute() {
    if (!this.app_name || !this.name) {
      console.warn(`[Module.makeModuleRoute] skipped — missing app_name or name (app_name=${this.app_name}, name=${this.name})`);
      return;
    }
    await fileManage.makeFolder(this.modulePath(), this.name.replaceAll(/\s+/g, '-').toLowerCase());
  }
}