'use strict';

import { BaseController, loopar } from 'loopar';

export default class ProjectUpdateController extends BaseController {
  constructor(props) {
    super(props);
  }

  /**
   * `Project Update/create?project=X` opens the form with the project
   * already chosen (the "New update" button of the Project form).
   */
  async actionCreate() {
    const project = String(this.query?.project ?? '').trim();
    if (this.hasData() || !project) return await super.actionCreate();

    const document = await loopar.newDocument(this.document, { project });
    if (this.preloaded == true) return await document.values();

    Object.assign(this.response, await document.__meta__());
    return await this.render(this.response);
  }
}
