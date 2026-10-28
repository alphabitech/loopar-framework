/**
 * Page kind — UI of page/web entries (no logic layer of their own):
 *
 *   import { PageLayout } from "@loopar/page";
 *
 *   layout.jsx       <PageLayout/>  structure + history (web or desk page)
 *   web-layout.jsx   <WebLayout/>   structure only, no chrome, no history
 *
 * Desk-only layouts are NOT exported here, so web pages never load the desk chrome:
 * desk-page-layout.jsx (<DeskPageLayout/>, DeskUI) and dashboard-layout.jsx
 * (<DashboardLayout/>, recharts) ship as their own chunks (see `kindModules` in ../Entry.jsx).
 */
export { PageLayout } from "./layout";
export { WebLayout } from "./web-layout";
