'use strict';

import { BaseController } from 'loopar';

/**
 * Any signed-in desk user may look people up (no grant needed): the directory
 * only exposes names. Web users are refused by the desk and get no rows.
 */
export default class UserDirectoryController extends BaseController {
  static freeActions = ['list', 'search', 'view'];

  constructor(props) {
    super(props);
  }
}
