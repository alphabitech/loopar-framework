'use strict';

import { BaseDocument } from 'loopar';

/**
 * A named view of an entity's list: its filters, sort, view type and report,
 * private to its user or shared with everyone who can open the list. Written
 * by the list itself through SavedViewController; see
 * packages/loopar/core/document/saved-views.js.
 */
export default class SavedView extends BaseDocument {
  constructor(props) {
    super(props);
  }
}
