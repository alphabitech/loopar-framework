'use strict';

import { BaseController, loopar, chartData, getChart } from 'loopar';

export default class DashboardChartController extends BaseController {
  // Chart data is authorized by the charted entity (the viewer must be able
  // to list it), not by the chart record: desk pages and dashboards show
  // charts to users who never open Dashboard Chart itself.
  freeActions = ['data'];

  constructor(props) {
    super(props);
  }

  /** `Dashboard Chart/data?name=<chart>` → { type, label, labels, values } | { denied } | { issue } */
  async actionData() {
    const name = this.query?.name ?? this.data?.name;
    return await chartData(await getChart(name), loopar.auth.user());
  }
}
