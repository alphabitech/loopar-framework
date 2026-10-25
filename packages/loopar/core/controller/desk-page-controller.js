'use strict'

import SingleController from './single-controller.js';
import { deskElementData } from '../document/desk-page.js';

/**
 * Controller of every Desk Page (the builder generates `<Page>Controller
 * extends DeskPageController`). The page itself renders like a page; its data
 * elements ask for their values through `view` with `?element=<node>`, so
 * reading a card needs exactly the permission to open the page — and what the
 * card reads is filtered again by the user's permissions on its entity.
 */
export default class DeskPageController extends SingleController {
  client = 'page';
  static inheritedActions = ['view'];

  constructor(props) {
    super(props);
  }

  async actionView(...args) {
    const element = this.query?.element ?? this.data?.element;
    if (element) return await deskElementData(this.document, String(element));

    return await this.sendDocument(...args);
  }
}
