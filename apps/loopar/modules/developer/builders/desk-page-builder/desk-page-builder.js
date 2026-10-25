'use strict';

import Builder from '../../../../../loopar/modules/core/entities/entity/entity.js';
import { loopar, fileManage, listDeskPages } from "loopar";

export default class DeskPageBuilder extends Builder {
  constructor(props) {
    super(props);
  }

  /** A builder instance without name/module must never touch the filesystem. */
  #hasIdentity() {
    return !!(this.name && this.module);
  }

  async modulePath() {
    return loopar.makePath("apps", await this.targetApp(), "modules", this.module, "desk-pages");
  }

  async save() {
    if (!this.#hasIdentity()) {
      console.warn("[Desk Page Builder] save skipped: name and module are required.");
      return;
    }

    await super.save(...arguments);

    if (loopar.utils.trueValue(this.is_home)) await this.#clearOtherHomes();
  }

  async makeViews() {
    if (!this.#hasIdentity()) return;
    return await super.makeViews(...arguments);
  }

  /** One home per app: the page just marked home unmarks the others (row + file). */
  async #clearOtherHomes() {
    const app = await this.targetApp();

    for (const page of listDeskPages(app)) {
      if (page.name === this.name || !loopar.utils.trueValue(page.is_home)) continue;

      const ref = loopar.getRef(page.name, false);
      if (!ref) continue;

      await loopar.db.setValue("Desk Page Builder", "is_home", 0, page.name);
      const cfg = fileManage.getConfigFile(page.name, ref.__ROOT__);
      if (cfg) await fileManage.setConfigFile(page.name, { ...cfg, is_home: 0 }, ref.__ROOT__);
    }
  }
}
