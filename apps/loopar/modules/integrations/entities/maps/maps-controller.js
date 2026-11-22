'use strict';

import { SingleController, loopar } from 'loopar';

export default class MapsController extends SingleController {
  static publicActions = ['config'];

  constructor(props) {
    super(props);
  }

  /** Map style of the site and whether addresses can be looked up — what `map` elements draw with. */
  async publicActionConfig() {
    const maps = await loopar.getDocument('Maps');
    return { maps: maps.publicConfig() };
  }

  /** The point of an address (`address` in the body): `{ place }`, null when it is not found. */
  async actionGeocode() {
    const maps = await loopar.getDocument('Maps');
    return { place: await maps.geocode(this.data?.address ?? this.query?.address) };
  }
}
