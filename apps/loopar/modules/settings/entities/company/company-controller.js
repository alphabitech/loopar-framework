'use strict';

import { SingleController, getCompany } from 'loopar';

export default class CompanyController extends SingleController {
  // Brand colors are public identity, not secrets: the theme picker of any
  // desk user previews the "Company brand" palette with them.
  static freeActions = ['brand'];

  constructor(props) {
    super(props);
  }

  async actionBrand() {
    const company = await getCompany();
    return { brand: company?.brand || null };
  }
}
