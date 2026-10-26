'use strict';

import { BaseController, loopar, PermissionManager, dashboardItems, dashboardItemData } from 'loopar';

export default class DashboardController extends BaseController {
  // Items are authorized by what they read (see dashboard-data.js); opening
  // the dashboard itself is still checked here.
  freeActions = ['itemData', 'board'];

  constructor(props) {
    super(props);
  }

  /** Opening a dashboard shows the board; `update` keeps the form to edit it. */
  async actionView() {
    this.client = 'dashboard';
    return await super.actionView(...arguments);
  }

  /**
   * `Dashboard/board?name=<dashboard>` → { name, description, items } — the
   * board embedded in a Desk Page (the `dashboard` element).
   */
  async actionBoard() {
    const name = this.query?.name ?? this.data?.name;
    if (!PermissionManager.can("Dashboard", "view")) return { denied: true };

    const [dashboard] = await loopar.db.getAll("Dashboard", ["id", "name", "description"], { name });
    if (!dashboard) return { issue: "Dashboard not found" };

    const items = (await dashboardItems(dashboard)).map(({ id, parent_id, parent_document, ...item }) => item);
    return { name: dashboard.name, description: dashboard.description, items };
  }

  /** `Dashboard/itemData?name=<dashboard>&item=<item name>` → the item's data. */
  async actionItemData() {
    const name = this.query?.name ?? this.data?.name;
    const itemName = this.query?.item ?? this.data?.item;

    if (!PermissionManager.can("Dashboard", "view")) return { denied: true };

    const [dashboard] = await loopar.db.getAll("Dashboard", ["id", "name"], { name });
    if (!dashboard) return { issue: "Dashboard not found" };

    const item = (await dashboardItems(dashboard)).find(i => i.name === itemName);
    if (!item) return { issue: "Item not found" };

    return await dashboardItemData(item, loopar.auth.user());
  }
}
