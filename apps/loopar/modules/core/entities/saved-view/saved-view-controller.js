'use strict';

import { loopar, BaseController, listSavedViews, writeSavedView, deleteSavedView, scheduleSavedView } from 'loopar';

export default class SavedViewController extends BaseController {
  // Any signed-in user keeps their own views and reads the shared ones of the
  // lists they may open (checked per entity in core/document/saved-views.js).
  static freeActions = ['views', 'save', 'remove', 'schedule'];

  #entity() {
    const entity = String(this.query?.entity ?? this.data?.entity ?? '');
    const ref = entity && loopar.getRef(entity, false);
    if (!ref) loopar.throw({ code: 404, message: 'Unknown entity.' });
    return ref.__NAME__;
  }

  /** `Saved View/views?entity=X` → { views: [{ name, title, query, view_type, shared, mine }] } */
  async actionViews() {
    return { views: await listSavedViews(this.#entity()) };
  }

  /** Body: `{ entity, title, query, view_type, shared, name? }` — `name` replaces one of the user's own views. */
  async actionSave() {
    return { saved: await writeSavedView(this.#entity(), this.data || {}) };
  }

  /**
   * Body: `{ name, schedule, to }` — emails one of the user's own views on a
   * schedule ("daily" | "weekly" | "monthly"; "none" stops it). Needs the
   * `export` grant on the view's entity.
   */
  async actionSchedule() {
    return { saved: await scheduleSavedView(String(this.data?.name ?? ''), { schedule: String(this.data?.schedule ?? 'none'), to: this.data?.to }) };
  }

  /** Body: `{ name }` — removes one of the user's own views. */
  async actionRemove() {
    await deleteSavedView(String(this.data?.name ?? this.query?.name ?? ''));
    return { removed: true };
  }
}
