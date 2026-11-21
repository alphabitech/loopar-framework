import MetaComponent from "@meta-component";
import { defineLayout } from "../base/define-layout";
import { PageTrail } from "../chrome/trail";

/** Page document (web or desk): structure + history; in the desk, its trail in the top bar. */
export const PageLayout = defineLayout("PageLayout", ({ ctrl, children }) => (
  <>
    <PageTrail />
    <MetaComponent elements={ctrl.__STRUCTURE__} parent={ctrl} />
    {children}
    {ctrl.getDocumentHistory?.(true)}
  </>
));
