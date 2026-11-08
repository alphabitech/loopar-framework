'use strict';

import { BaseDocument } from 'loopar';
import { translatorContext } from './translator-service.js';

/** The Translator page: the dictionaries of the installed apps, per language. */
export default class Translator extends BaseDocument {
  constructor(props) {
    super(props);
  }

  async __meta__() {
    return { ...await super.__meta__(), data: translatorContext() };
  }
}
