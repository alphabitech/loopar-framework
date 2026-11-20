import { useWorkspace } from "@workspace/workspace-provider";
import { parseOptionLines } from "@global/select-options";
import { multipleValues } from "@global/element-definition";
import loopar from "loopar";
import {Link} from "@link";
import { useTable } from "./TableContext.jsx"
import { recordLink } from "./record-link.js"
import { titleFieldsOf } from "./list-columns.js"
import { resolveListColumns, TITLE_COLUMN } from "@global/list-settings";
import { ListColumnsMenu } from "./ListColumnsMenu.jsx";
import { ListFilters } from "./ListFilters.jsx";
import { useViewOptions } from "@loopar/document";
import BaseTable from "./BaseTable.jsx"
import {useMemo} from "react";
import {DynamicIcon} from "@icon-input";

import { CheckIcon } from "lucide-react";
import { TableSearch } from "./TableSearch";
import { RowMenu } from "./RowMenu.jsx";
import { DropdownListGridActions } from "./DropdownListGridActions";
import { __ } from "@global/i18n";
import { formatDate, formatDateTime, formatCurrency } from "@global/format";

export function ListGrid(props) {
  const { columns, hasSelectAll, hasListSettings } = useViewOptions();
  // The select-all menu sits in the toolbar, next to the search (as in the grid view).
  const inToolbar = hasSelectAll !== false;
  const {baseColumns, Document, selectorCol, deleteRow, search, listSettings, saveListSettings} = useTable();
  const portal = useWorkspace().workspace === "portal";

  const customMappedColumns = useMemo(() => {
    const Entity = Document.Entity;
    const titleFields = titleFieldsOf(Entity);
    // The user's columns: order, hidden and extra ones (global/list-settings.js).
    const visible = resolveListColumns(baseColumns(), listSettings);
    const widths = listSettings?.widths || {};
    const nameVisible = visible.some((col) => col.data.name === "name");

    // Type-aware rendering; every list column is a real column, so it can sort.
    const decorate = (source) => {
      const name = source.data.name;
      const col = { ...source, sortable: true, resizable: true, reorderable: true, width: widths[name] };

      if ([SWITCH, CHECKBOX].includes(col.element)) {
        col.headProps = { className: "text-center" };
        col.render = (row) => (
          <div className="flex justify-center">
            {loopar.utils.trueValue(row[name])
              ? <CheckIcon className="h-4 w-4 text-green-500" aria-label={__("Yes")} />
              : <span className="text-muted-foreground" aria-label={__("No")}>—</span>}
          </div>
        );
      }

      // Dates, money and choices in the user's regional format / language.
      if (col.element === "date") col.render ??= (row) => formatDate(row[name], "short");
      if (col.element === "date_time") col.render ??= (row) => formatDateTime(row[name], "short");
      if (col.element === "currency" || col.data.format === "currency") col.render ??= (row) => formatCurrency(row[name]);
      if (["select", "radio_group"].includes(col.element) && typeof col.data.options === "string") {
        const labels = Object.fromEntries(parseOptionLines(col.data.options).map((o) => [o.value, o.label]));
        const multiple = [1, "1", true, "true"].includes(col.data.multiple);
        col.render ??= (row) => multiple
          ? multipleValues(row[name]).map((v) => __(labels[v] ?? v)).join(", ")
          : __(labels[row[name]] ?? row[name]);
      }

      return col;
    };

    if (columns) {
      // View-defined columns: the view lays them out (and links its own rows).
      const customCols = columns(visible.filter((col) => col.data.name !== "name").map(decorate));
      return [
        ...(inToolbar ? [selectorCol({deleteOnServer: true, header: false})] : []),
        ...customCols
      ];
    }

    const withCellProps = (col) => {
      if (col.element === ICON_INPUT) {
        return { ...col, render: (row) => <DynamicIcon className="w-7 h-7" icon={row[col.data.name]} /> };
      }
      return col.cellProps ? col : { ...col, cellProps: { className: "align-middle py-2" } };
    };

    const linkClass = "flex min-w-0 flex-col items-start justify-center gap-0 p-0 leading-tight hover:underline";
    let primary, rest;

    if (titleFields.length) {
      // Title column: the record's title (title_fields), with its name below
      // while `name` is a list column. Sorts by the first title field.
      const firstTitle = baseColumns().find((col) => col.data?.name === titleFields[0]);
      rest = visible.filter((col) => col.data.name !== "name" && !titleFields.includes(col.data.name)).map(decorate);
      primary = {
        data: { name: "__title__", label: firstTitle?.data?.label || "Name" },
        sortable: true,
        sortField: titleFields[0],
        // Always first: it can be resized, not moved.
        resizable: true,
        widthKey: TITLE_COLUMN,
        width: widths[TITLE_COLUMN],
        cellProps: { className: "py-2" },
        render: (row) => {
          // `__titles__`: titles of linked records, sent by the list (BaseDocument.getList).
          const title = titleFields.map((field) => row.__titles__?.[field] ?? row[field]).filter(Boolean).join(" ") || row.name;
          const showName = nameVisible && String(title).toLowerCase() !== String(row.name).toLowerCase();

          return (
            <Link to={recordLink(Entity, row.name, row, { portal })} renderOnRestrict={true} className={linkClass}>
              <span className="truncate font-medium text-foreground">{title}</span>
              {showName && <span className="truncate text-xs text-muted-foreground">{row.name}</span>}
            </Link>
          );
        }
      };
    } else {
      // No title: the first list column opens the record. `name` is a column
      // like any other (shown only while it is in the list view).
      const cols = visible.length ? visible.map(decorate) : [{ data: { name: "name", label: "Name" }, sortable: true, resizable: true, width: widths.name }];
      const first = cols[0];
      rest = cols.slice(1);
      primary = {
        ...first,
        cellProps: { className: "py-2" },
        render: (row) => {
          const content = first.render ? first.render(row) : (row.__titles__?.[first.data.name] ?? row[first.data.name]);
          const empty = content === null || content === undefined || content === "";

          return (
            <Link to={recordLink(Entity, row.name, row, { portal })} renderOnRestrict={true} className={linkClass}>
              <span className="truncate font-medium text-foreground">{empty ? row.name : content}</span>
            </Link>
          );
        }
      };
    }

    return [
      // No selection without the select-all menu (its bulk actions): e.g. the portal.
      ...(inToolbar ? [selectorCol({deleteOnServer: true, colSpan: 1, header: false})] : []),
      primary,
      ...rest.map(withCellProps),
      {
        data: {
          name: "actions",
          label: () => <span className="sr-only">{__("Actions")}</span>,
        },
        headProps: { className: "w-14 p-2" },
        cellProps: { className: "w-14 py-1 pr-2 text-right align-middle" },
        render: (row) => <RowMenu row={row} Entity={Entity} onDelete={(r) => deleteRow(r, true)} />,
      }
    ];
  }, [baseColumns, columns, Document, deleteRow, selectorCol, listSettings, inToolbar, portal]);

  // Runtime column changes, saved per user. Views with their own `columns` lay them out themselves.
  const customizable = !columns && !!saveListSettings && hasListSettings !== false;

  const resizeColumn = (key, width) => {
    const widths = { ...listSettings.widths };
    width ? (widths[key] = width) : delete widths[key];
    saveListSettings({ widths });
  };

  const reorderColumn = (from, to) => {
    const order = resolveListColumns(baseColumns(), listSettings).map((col) => col.data.name);
    const fromIndex = order.indexOf(from), toIndex = order.indexOf(to);
    if (fromIndex < 0 || toIndex < 0) return;
    order.splice(toIndex, 0, order.splice(fromIndex, 1)[0]);
    saveListSettings({ order });
  };

  return (
    <>
      <div className="flex items-start gap-2">
        {inToolbar && <DropdownListGridActions deleteOnServer={true}/>}
        <div className="min-w-0 flex-1">
          <TableSearch onChange={search}/>
        </div>
        <ListFilters/>
        {customizable && <ListColumnsMenu/>}
      </div>
      <BaseTable
        {...props}
        totals={Document.totals}
        hasPagination={props.hasPagination !== false}
        columns={customMappedColumns}
        onResize={customizable ? resizeColumn : undefined}
        onReorder={customizable ? reorderColumn : undefined}
      />
    </>
  )
}