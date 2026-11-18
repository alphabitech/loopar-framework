import DeskUI from "../chrome/desk-ui";
import { ListGrid } from "@@table/ListGrid";
import { GridView } from "@@table/GridView";
import { defineLayout } from "../base/define-layout";
import { useList } from "./provider";
import { useViewOptions } from "../base/view-options";
import { KanbanBoard } from "./kanban";
import { CalendarView } from "./calendar";
import { ReportView } from "./report";

/** Desk list: chrome + List/Grid/Kanban/Calendar/Report (view picked from the list layer). */
export const ListLayout = defineLayout("ListLayout", ({ ctrl, children }) => {
  const { viewType, viewTypeToggle, setViewType, applyView } = useList();
  const { hasSearchForm = true, onlyGrid, onlyList } = useViewOptions();
  // Kanban, Calendar and Report only on full lists, never on embedded ones.
  const special = onlyGrid !== true && !onlyList;
  const showList = (onlyGrid === true ? "Grid" : viewType) === "List" || onlyList;

  return (
    <DeskUI docRef={ctrl} viewTypeToggle={viewTypeToggle} setViewType={setViewType} viewType={viewType} applyView={special ? applyView : undefined}>
      {children}
      {viewType === "Kanban" && special ? (
        <KanbanBoard ctrl={ctrl} />
      ) : viewType === "Calendar" && special ? (
        <CalendarView ctrl={ctrl} />
      ) : viewType === "Report" && special ? (
        <ReportView ctrl={ctrl} />
      ) : showList ? (
        <ListGrid hasSearchForm={hasSearchForm} docRef={ctrl} />
      ) : (
        <GridView hasSearchForm={hasSearchForm} docRef={ctrl} />
      )}
    </DeskUI>
  );
});
