import loopar from "loopar";
import {Link} from "@link";
import { useTable } from "./TableContext.jsx"
import { useViewOptions } from "@loopar/document";
import BaseTable from "./BaseTable.jsx"
import {useCallback, useMemo} from "react";
import {DynamicIcon} from "@icon-input";

import { CheckIcon } from "lucide-react";
import { TableSearch } from "./TableSearch";
import { RowMenu } from "./RowMenu.jsx";

export function ListGrid(props) {
  const { columns } = useViewOptions();
  const {baseColumns, Document, selectorCol, deleteRow, search} = useTable();

  const getDocumentTitle = (row) => {
    
    const titleFields = Document.Entity.title_fields?.split(",");

    if(titleFields){
      // `__titles__`: titles of linked records, sent by the list (BaseDocument.getList).
      return titleFields.map((field) => row.__titles__?.[field?.trim()] ?? row[field?.trim()]).filter(Boolean).join(" ");
    }

    return row.name;
  }

  const mappedColumns = useCallback(() => {
    return baseColumns().filter((col) => col.data.name !== "name" && loopar.utils.trueValue(col.data.in_list_view));
  }, [baseColumns]);

  const customMappedColumns = useMemo(() => {
    const baseCols = (mappedColumns() || []).filter(col => col.data.name !== "name")
      .map((col) => {
        if([SWITCH, CHECKBOX].includes(col.element)) {
          col.headProps = { className: "text-center" };
          col.render = (row) => (
            <div className="flex justify-center">
              {loopar.utils.trueValue(row[col.data.name])
                ? <CheckIcon className="h-4 w-4 text-green-500" aria-label="Yes" />
                : <span className="text-muted-foreground" aria-label="No">—</span>}
            </div>
          );
        }

        return col;
      });

    if(columns){
      const customCols = columns(baseCols);
      return [
        selectorCol({deleteOnServer: true}),
        ...customCols
      ];
    }

    return [
      selectorCol({deleteOnServer: true}),
      {
        data: {
          name: "mame",
          label: null//because first column is selector and spands 2 columns
        },
        cellProps: { className: "py-2" },
        render: (row) => {
          const title = getDocumentTitle(row) || row.name;
          const showName = String(title).toLowerCase() !== String(row.name).toLowerCase();

          return (
            <Link
              to={`update?name=${row.name}`}
              renderOnRestrict={true}
              className="flex min-w-0 flex-col items-start justify-center gap-0 p-0 leading-tight hover:underline"
            >
              <span className="truncate font-medium text-foreground">{title}</span>
              {showName && <span className="truncate text-xs text-muted-foreground">{row.name}</span>}
            </Link>
          );
        }
      },
      ...baseCols.map((col) => {
        if(col.element === ICON_INPUT){
          return {
            ...col,
            render: (row) => {
              return (
                <DynamicIcon className="w-7 h-7" icon={row[col.data.name]} />
              )
            }
          }
        }

        return col.cellProps ? col : { ...col, cellProps: { className: "align-middle py-2" } };
      }),
      {
        data: {
          name: "actions",
          label: () => <span className="sr-only">Actions</span>,
        },
        headProps: { className: "w-12 p-2" },
        cellProps: { className: "w-12 py-1 pr-2 text-right align-middle" },
        render: (row) => <RowMenu row={row} Entity={Document.Entity} onDelete={(r) => deleteRow(r, true)} />,
      }
    ];
  }, [mappedColumns, columns, Document, deleteRow]);

  return (
    <>
      <TableSearch onChange={search}/>
      <BaseTable
        {...props}
        hasPagination={props.hasPagination !== false}
        columns={customMappedColumns}
      />
    </>
  )
}