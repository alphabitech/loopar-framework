import { createContext, useContext, useMemo } from "react";
import { usePersist } from "@services/persist-state";
import { TableProvider, useTable } from "@@table/TableContext";
import { listViews, nextListView } from "./views";

/** List middleware: table state (rows, selection, search, pagination) + persisted List/Grid view type. */
const ListContext = createContext(null);

export function ListProvider({ ctrl, children }) {
  const Document = ctrl.Document;
  const [viewType, setViewType] = usePersist(
    Document.Entity.name + "_viewType",
    Document.Entity.default_list_view || "List"
  );

  // Kanban only exists for entities with an active workflow.
  const views = listViews(Document);
  const current = views.includes(viewType) ? viewType : "List";

  const value = useMemo(() => ({
    ctrl,
    viewType: current,
    setViewType,
    viewTypeToggle: () => setViewType(nextListView(Document, current)),
  }), [ctrl, current, setViewType, Document]);

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
