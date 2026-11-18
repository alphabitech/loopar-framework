'use strict';

import { BaseDocument, loopar } from 'loopar';

/**
 * Project Update: a dated entry of a Project — a note and/or photos of the
 * job site, by stage (before, in progress, after, an issue). Each user
 * writes their own entries, so the people on site report progress without
 * needing to edit the Project itself.
 */
export default class ProjectUpdate extends BaseDocument {
  constructor(props) {
    super(props);
  }

  async beforeSave() {
    this.project = String(this.project ?? '').trim();
    if (!this.project) loopar.throw('Choose the project this update belongs to.');
    if (!await loopar.db.getRow('Project', this.project, ['name'])) loopar.throw(`Project ${this.project} does not exist.`);

    if (!this.update_date) this.update_date = new Date().toISOString().slice(0, 10);
    this.stage ||= 'In Progress';
  }
}
