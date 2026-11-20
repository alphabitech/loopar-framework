'use strict';

import { DeskPageController } from 'loopar';

/**
 * Home of every app without a Desk Page of its own (`?app=<name>`): its
 * modules and documents as cards. What it lists comes from the desk menu,
 * already filtered by the viewer's permissions, so any desk user may open it.
 */
export default class AppHomeController extends DeskPageController {
  static freeActions = ['view'];

  constructor(props) {
    super(props);
  }
}
