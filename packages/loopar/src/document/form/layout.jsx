import DeskUI from "../chrome/desk-ui";
import { defineLayout } from "../base/define-layout";
import { StructureFields } from "./structure-fields";
import { useViewOptions } from "../base/view-options";
import { WorkflowBar } from "./workflow-bar";
import { RecordEvents } from "./record-events";

/** Desk form (create/update) and read-only view: chrome + structure fields + the record's events + history. */
export const FormLayout = defineLayout("FormLayout", ({ ctrl, children }) => {
  const { hasHistory } = useViewOptions();

  return (
    <DeskUI docRef={ctrl}>
      <WorkflowBar ctrl={ctrl} />
      <StructureFields ctrl={ctrl} />
      <RecordEvents ctrl={ctrl} />
      {hasHistory !== false && ctrl.getDocumentHistory?.()}
      {children}
    </DeskUI>
  );
});
