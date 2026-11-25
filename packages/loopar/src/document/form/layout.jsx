import DeskUI from "../chrome/desk-ui";
import { useDocument } from "../base/provider";
import { defineLayout } from "../base/define-layout";
import { StructureFields } from "./structure-fields";
import { useViewOptions } from "../base/view-options";
import { RecordEvents } from "./record-events";
import { LiveRecord } from "./live-record";
import { DocumentFlow } from "./document-flow";
import { PanelDefaultsContext, FORM_PANEL_DEFAULTS } from "../../components/panel-defaults";

/**
 * Desk form (create/update) and read-only view: chrome + the record's flow (`flow`
 * view option) + structure fields + the record's events + history (in the record
 * panel when there is one); follows changes made elsewhere (LiveRecord). Panels
 * inside a form have no hover/focus effects unless they set them (panel-defaults).
 */
export const FormLayout = defineLayout("FormLayout", ({ ctrl, children }) => {
  const { hasHistory, hasSidebar } = useViewOptions();
  const { inModal } = useDocument();
  // With the record panel (desk-ui), history lives there; otherwise at the end of the form.
  const historyInPanel = hasSidebar !== false && !inModal;

  return (
    <DeskUI docRef={ctrl}>
      <LiveRecord ctrl={ctrl} />
      <DocumentFlow />
      <PanelDefaultsContext.Provider value={FORM_PANEL_DEFAULTS}>
        <StructureFields ctrl={ctrl} />
      </PanelDefaultsContext.Provider>
      <RecordEvents ctrl={ctrl} />
      {hasHistory !== false && !historyInPanel && ctrl.getDocumentHistory?.()}
      {children}
    </DeskUI>
  );
});
