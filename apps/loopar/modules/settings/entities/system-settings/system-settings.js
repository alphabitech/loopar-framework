
'use strict';

import { loopar, BaseDocument } from 'loopar';
import { themeCSS } from './theme-css.js';
import fs from 'fs'

export default class SystemSettings extends BaseDocument {
  constructor(props) {
    super(props);
  }

  async save() {
    await super.save();
    await this.setTheme();

    await loopar.build();
  }

  async onLoad() {
    await super.onLoad();
  }

  async setTheme() {
    // The tenant theme: used by every site whose web app has no theme of its own.
    const css = await themeCSS(this.theme, { fallbackTheme: 'slate' });
    fs.writeFileSync(loopar.makePath(loopar.tenantPath, 'theme.css'), css, 'utf8');
  }
}