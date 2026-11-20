import { useEffect, useRef } from "react";
import loopar, { useRealtime } from "loopar";
import { __ } from "@global/i18n";

/**
 * Keeps an open record form in step with changes made elsewhere — another
 * user, a workflow, a customer approving on a link. The server announces each
 * write in the record's room (`doc:<Entity>/<name>`, only the new version);
 * the form then refreshes softly: server values come in and the fields the
 * user is editing (unsaved) are kept, so nothing typed is lost. A save made
 * over an older version is still refused by the record's version check.
 */
export function LiveRecord({ ctrl }) {
  const Document = ctrl.Document;
  const entity = Document?.Entity?.name;
  const name = Document?.name || Document?.data?.name;
  const live = Document?.meta?.action === "update" && !Document?.isNew && !!entity && !!name
    && !Document?.Entity?.is_single && !ctrl.props?.inModal;
  const timer = useRef(null);

  useEffect(() => () => clearTimeout(timer.current), []);

  useRealtime(live ? `doc:${entity}/${name}:updated` : null, live ? (payload = {}) => {
    // Our own save already brought this version.
    if (payload.version != null && String(payload.version) === String(ctrl.recordVersion ?? "")) return;
    clearTimeout(timer.current);
    // Several writes of one change (record + children + hooks) refresh once.
    timer.current = setTimeout(() => {
      const editing = ctrl.hasChanges?.();
      loopar.refresh();
      if (editing || (payload.user && payload.user !== window.__user__)) {
        loopar.notify(
          payload.user && payload.user !== window.__user__
            ? __("Updated by") + ` ${payload.user}` + (editing ? `. ${__("Your unsaved changes were kept.")}` : "")
            : __("This record was updated.") + (editing ? ` ${__("Your unsaved changes were kept.")}` : ""),
          "info",
        );
      }
    }, 400);
  } : null);

  useRealtime(live ? `doc:${entity}/${name}:deleted` : null, live ? () => {
    loopar.notify(__("This record was deleted by someone else."), "warning");
  } : null);

  return null;
}
