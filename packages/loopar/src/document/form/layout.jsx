import DeskUI from "../chrome/desk-ui";
import { useDocument } from "../base/provider";
import { defineLayout } from "../base/define-layout";
import { StructureFields } from "./structure-fields";
import { useViewOptions } from "../base/view-options";
import { RecordEvents } from "./record-events";
import { LiveRecord } from "./live-record";

/** Desk form (create/update) and read-only view: chrome + structure fields + the record's events + history (in the record panel when there is one); follows changes made elsewhere (LiveRecord). */
export const FormLayout = defineLayout("FormLayout", ({ ctrl, children }) => {
  const { hasHistory, hasSidebar } = useViewOptions();
  const { inModal } = useDocument();
  // With the record panel (desk-ui), history lives there; otherwise at the end of the form.
  const historyInPanel = hasSidebar !== false && !inModal;

  return (
    <DeskUI docRef={ctrl}>
      <LiveRecord ctrl={ctrl} />
      <StructureFields ctrl={ctrl} />
      <RecordEvents ctrl={ctrl} />
      {hasHistory !== false && !historyInPanel && ctrl.getDocumentHistory?.()}
      {children}
    </DeskUI>
  );
});
