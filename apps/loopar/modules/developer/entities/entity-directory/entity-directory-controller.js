'use strict';

import { BaseController } from 'loopar';

/**
 * Any desk user may pick an entity (no grant needed): the directory only
 * exposes entity and field names, already visible in every desk URL.
 */
export default class EntityDirectoryController extends BaseController {
  static freeActions = ['list', 'search', 'view'];

  constructor(props) {
    super(props);
  }
}
