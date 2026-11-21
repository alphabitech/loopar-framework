import { createContext, useCallback, useContext, useMemo } from "react";
import { usePersist } from "@services/persist-state";
import { useWorkspace } from "@workspace/workspace-provider";
import { TableProvider, useTable } from "@@table/TableContext";
import { listFields, flatElements, defaultReportSpec } from "@@table/list-fields";
import { queryOf, urlWith } from "@@table/list-url";
import { REPORT_PARAM, REPORT_PARAMS, formatReportSpec } from "@global/list-report";
import { listViews, nextListView, treeOf } from "./views";

/**
 * List middleware: table state (rows, selection, search, pagination) + the
 * view type. List / Grid / Tree / Kanban / Calendar are persisted per user; Report
 * is in the URL (`?report=…`): opening such a link shows the report, picking
 * another view leaves it.
 */
const ListContext = createContext(null);

export function ListProvider({ ctrl, children }) {
  const Document = ctrl.Document;
  const { pathname: currentUrl, navigate } = useWorkspace();
  // The view a list opens in until the user picks another: the entity's own
  // (`default_list_view`) when it names one other than the plain list; an
  // entity that nests opens as a tree.
  const configured = Document.Entity.default_list_view;
  const defaultView = configured && configured !== "List" ? configured : (treeOf(Document) ? "Tree" : "List");
  const [viewType, setPersisted] = usePersist(Document.Entity.name + "_viewType", defaultView);

  // Kanban only exists for entities with an active workflow.
  const views = listViews(Document);
  const reportInUrl = queryOf(currentUrl).has(REPORT_PARAM);
  const fallback = views.includes(defaultView) && defaultView !== "Report" ? defaultView : "List";
  const stored = views.includes(viewType) && viewType !== "Report" ? viewType : fallback;
  const current = reportInUrl ? "Report" : stored;

  const setViewType = useCallback((view) => {
    if (view === "Report") {
      if (reportInUrl) return;
      const fields = listFields(flatElements(Document.Entity?.doc_structure), { recordDates: !!Document.record_dates });
      const report = formatReportSpec(defaultReportSpec(fields, { workflowField: Document.workflow?.field }));
      navigate(urlWith(currentUrl, (params) => {
        Object.entries(report).forEach(([key, value]) => params.set(key, value));
        params.delete("page");
      }));
      return;
    }
    setPersisted(view);
    if (reportInUrl) navigate(urlWith(currentUrl, (params) => REPORT_PARAMS.forEach((key) => params.delete(key))));
  }, [reportInUrl, currentUrl, navigate, setPersisted, Document]);

  /** Opens a saved view (`{ view_type, query }`): its view type and the URL query it keeps. */
  const applyView = useCallback((view) => {
    const type = views.includes(view?.view_type) ? view.view_type : "List";
    if (type !== "Report") setPersisted(type);
    const [path] = String(currentUrl || "").split("?");
    navigate(view?.query ? `${path}?${view.query}` : path);
  }, [views.join("|"), currentUrl, navigate, setPersisted]);

  const value = useMemo(() => ({
    ctrl,
    viewType: current,
    setViewType,
    applyView,
    viewTypeToggle: () => setViewType(nextListView(Document, current)),
  }), [ctrl, current, setViewType, applyView, Document]);

  return (
    <ListContext.Provider value={value}>
      <TableProvider initialDocument={Document} docRef={ctrl} rows={Document.rows}>
        {children}
      </TableProvider>
    </ListContext.Provider>
  );
}

export function useList() {
  const list = useContext(ListContext);
  if (!list) throw new Error("useList() must be used inside the list entry.");
  const table = useTable();
  return { ...table, ...list };
}
