'use strict';

import { BaseDocument, loopar } from 'loopar';

const CHART_TYPES = ["bar", "line", "area", "donut"];

/** A chart over the records of an entity: see packages/loopar/core/document/dashboard-data.js. */
export default class DashboardChart extends BaseDocument {
  constructor(props) {
    super(props);
  }

  async validate() {
    await super.validate(...arguments);
    if (loopar.installing) return;

    const ref = loopar.getRef(String(this.entity || "").trim(), false);
    if (!ref || ref.is_single || ref.is_child || !["Entity", "Contact Form"].includes(ref.__TYPE__)) {
      loopar.throw(`"${this.entity || ""}" is not an entity with records.`);
    }
    this.entity = ref.__NAME__;

    if (!CHART_TYPES.includes(this.chart_type)) loopar.throw(`Unknown chart type "${this.chart_type}".`);

    const fields = new Set([...(ref.__FIELDS__ || []), "__created_at__", "__updated_at__"]);
    if (!fields.has(this.x_field)) loopar.throw(`Field "${this.x_field || ""}" is not in ${ref.__NAME__}.`);
    if (this.aggregate !== "count" && !fields.has(this.value_field)) {
      loopar.throw(`Sum and Average need a value field of ${ref.__NAME__}.`);
    }
    if (this.filter && !loopar.utils.isJSON(this.filter)) loopar.throw("Filter must be a JSON object.");
  }
}
