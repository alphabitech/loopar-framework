/**
 * Page kind — UI of page/web entries (no logic layer of their own):
 *
 *   import { PageLayout } from "@loopar/page";
 *
 *   layout.jsx       <PageLayout/>  structure + history (web or desk page)
 *   web-layout.jsx   <WebLayout/>   structure only, no chrome, no history
 *   desk-page-layout.jsx <DeskPageLayout/>  desk page blocks with the app gap, no history
 *   dashboard-layout.jsx <DashboardLayout/>  Dashboard record as a board of charts and numbers
 */
export { PageLayout } from "./layout";
export { WebLayout } from "./web-layout";
export { DeskPageLayout } from "./desk-page-layout";
export { DashboardLayout } from "./dashboard-layout";
