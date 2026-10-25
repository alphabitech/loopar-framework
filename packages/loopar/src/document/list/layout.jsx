import DeskUI from "../chrome/desk-ui";
import { ListGrid } from "@@table/ListGrid";
import { GridView } from "@@table/GridView";
import { defineLayout } from "../base/define-layout";
import { useList } from "./provider";
import { useViewOptions } from "../base/view-options";
import { KanbanBoard } from "./kanban";

/** Desk list: chrome + List/Grid/Kanban (toggle from the list layer). */
export const ListLayout = defineLayout("ListLayout", ({ ctrl, children }) => {
  const { viewType, viewTypeToggle } = useList();
  const { hasSearchForm = true, onlyGrid, onlyList } = useViewOptions();
  const showList = (onlyGrid === true ? "Grid" : viewType) === "List" || onlyList;

  return (
    <DeskUI docRef={ctrl} viewTypeToggle={viewTypeToggle} viewType={viewType}>
      {children}
      {viewType === "Kanban" && onlyGrid !== true && !onlyList ? (
        <KanbanBoard ctrl={ctrl} />
      ) : showList ? (
        <ListGrid hasSearchForm={hasSearchForm} docRef={ctrl} />
      ) : (
        <GridView hasSearchForm={hasSearchForm} docRef={ctrl} />
      )}
    </DeskUI>
  );
});
