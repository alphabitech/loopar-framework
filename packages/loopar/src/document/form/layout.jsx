import DeskUI from "../chrome/desk-ui";
import { defineLayout } from "../base/define-layout";
import { StructureFields } from "./structure-fields";
import { useViewOptions } from "../base/view-options";
import { WorkflowBar } from "./workflow-bar";

/** Desk form (create/update) and read-only view: chrome + structure fields + history. */
export const FormLayout = defineLayout("FormLayout", ({ ctrl, children }) => {
  const { hasHistory } = useViewOptions();

  return (
    <DeskUI docRef={ctrl}>
      <WorkflowBar ctrl={ctrl} />
      <StructureFields ctrl={ctrl} />
      {hasHistory !== false && ctrl.getDocumentHistory?.()}
      {children}
    </DeskUI>
  );
});
