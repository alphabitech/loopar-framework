import { useMemo } from "react";
import { useTable } from "./TableContext";
import loopar from "loopar";

import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
  TableFooter,
} from "@cn/components/ui/table";

import { EmptyTable } from "./EmptyTable";
import { __ } from "@global/i18n";

export function SimpleTable(props) {
  const {baseColumns, tableId} = useTable();
  const rows = props.rows || useTable().rows || [];

  const mappedColumns = useMemo(() => {
    return props.columns || baseColumns;
  }, [baseColumns, props.columns]);

  const availableColumns = useMemo(() => {
    return mappedColumns
  }, [mappedColumns]);

  const renderRows = () =>
    rows.map((row, index) => {
      if(props.rowTemplate){
        const RowTemplate = props.rowTemplate
        return (
          <RowTemplate
            key={`${tableId}-${row.name}-${index}`}
            row={row}
            index={index}
            columns={availableColumns}
          />
        )
      } 
      return (
        <TableRow key={`${tableId}-${row.name}-${index}`} className="group p-0 m-0 hover:bg-muted/40">
          {
            availableColumns.map((col) => {
              const cellProps = col.cellProps || {};
              const { data } = col;

              return (
                <TableCell
                  key={`${data.name}_${index}`}
                  className="align-middle"
                  {...cellProps}
                >
                  {col.render ? col.render(row, index) : (row.__titles__?.[data.name] ?? row[data.name])}
                </TableCell>
              );
            })
          }
        </TableRow>
      )
    });
  
  const rowsCount = rows.length;

  return (
    <Table 
      aria-label={__("sticky table")} 
      className="w-full overflow-hidden"
    >
      <TableHeader className="bg-muted/40">
        <TableRow className="[&>td]:h-10 [&>td]:py-2 [&>td]:text-xs [&>td]:font-medium [&>td]:text-muted-foreground">
          {availableColumns.filter(c => c.data?.label).map((c) => {
            const { data, headProps = {} } = c;
            return (
              <TableCell key={data.name} {...headProps}>
                {typeof data.label === "function" ? data.label() : (data.label || "")}
              </TableCell>
            );
          })}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rowsCount === 0 ? (
          <TableRow>
            <TableCell colSpan={availableColumns.length + 2}>
              <EmptyTable/>
            </TableCell>
          </TableRow>
        ) : (
          renderRows(availableColumns, rows)
        )}
      </TableBody>
      <TableFooter>
        <TableRow>
          {props.footer}
        </TableRow>
      </TableFooter>
    </Table>
  );
}