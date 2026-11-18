'use strict';

import { BaseController, loopar } from 'loopar';

const UPDATE = 'Project Update';
const MAX_UPDATES = 100;

/** `image_input` value (JSON list of files) → [{ name, src }]. */
const photosOf = (value) => {
  const files = Array.isArray(value) ? value : loopar.utils.JSONparse(value, []);
  return (Array.isArray(files) ? files : []).filter((f) => f?.src).map((f) => ({ name: f.name || '', src: f.src }));
};

export default class ProjectController extends BaseController {
  constructor(props) {
    super(props);
  }

  /**
   * Updates of one project, newest first, for the "Updates" panel of its
   * form: `Project/updates?name=X`. Its own permission (`updates`): seeing
   * the job-site notes and photos is granted apart from editing the project.
   */
  async actionUpdates() {
    const project = String(this.name || this.query?.name || '').trim();
    if (!project || !await loopar.db.getRow('Project', project, ['name'])) {
      loopar.throw({ code: 404, message: `Project ${project} not found.` });
    }

    const rows = await loopar.db.query(UPDATE)
      .where({ project })
      .whereNull('__deleted_at__')
      .orderBy([{ column: 'update_date', order: 'desc' }, { column: 'id', order: 'desc' }])
      .limit(MAX_UPDATES)
      .select('name', 'update_date', 'stage', 'note', 'photos', '__created_by__');

    // Data endpoint: no `message` key, so the client keeps the payload.
    return {
      updates: rows.map((row) => ({
        name: row.name,
        date: row.update_date ? String(row.update_date).slice(0, 10) : '',
        stage: row.stage || '',
        note: row.note || '',
        by: row.__created_by__ || '',
        photos: photosOf(row.photos),
      })),
    };
  }
}
