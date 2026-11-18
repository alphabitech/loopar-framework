'use strict';

import { BaseDocument, loopar } from 'loopar';

const clean = (value) => String(value ?? '').trim().replace(/\s+/g, ' ');
const asDate = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return isNaN(date.getTime()) ? null : date;
};

/**
 * Project: a job done for a Customer, from planned to completed. Generic on
 * purpose — it only holds what every app shares (who, where, when, state);
 * an app that needs more keeps it in its own entity linked through a
 * `project` field, the way apps extend Customer.
 *
 * `document` / `document_name` name the record the project came from (a
 * quote, an order…): set by the app that creates it (see ../../projects.js).
 * The state changes through the "Project" workflow.
 */
export default class Project extends BaseDocument {
  constructor(props) {
    super(props);
  }

  async beforeSave() {
    this.title = clean(this.title);
    if (!this.title) loopar.throw('The project needs a title.');

    const start = asDate(this.start_date);
    const end = asDate(this.end_date);
    if (start && end && end < start) loopar.throw('"End date" must be on or after "Start date".');

    this.status ||= 'Planned';
    this.document = clean(this.document) || null;
    this.document_name = clean(this.document_name) || null;
  }
}
