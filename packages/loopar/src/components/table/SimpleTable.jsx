import { useMemo, useRef, useState } from "react";
import { useTable } from "./TableContext";

import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
  TableFooter,
} from "@cn/components/ui/table";
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy, useSortable } from "@dnd-kit/sortable";

import { EmptyTable } from "./EmptyTable";
import { __ } from "@global/i18n";
import { cn } from "@cn/lib/utils";
import { ArrowDownIcon, ArrowUpIcon, ChevronsUpDownIcon } from "lucide-react";

const MIN_COLUMN_WIDTH = 60;

// A column with a width keeps it: longer content is cut, not wrapped.
const widthStyle = (width) => (width ? { width, minWidth: width, maxWidth: width } : undefined);

/**
 * Header label. Sortable columns (server lists) toggle the list order: each
 * click cycles the column (ascending → descending → off) within the current
 * sort, shift+click sorts by it alone. With several criteria each shows its
 * position.
 */
function HeadLabel({ col, sort, toggleSort }) {
  const { data } = col;
  const label = typeof data.label === "function" ? data.label() : (data.label || "");
  const field = col.sortField || data.name;
  if (!col.sortable || !toggleSort) return label;

  const index = sort.findIndex((s) => s.field === field);
  const active = index >= 0;
  const SortIcon = !active ? ChevronsUpDownIcon : sort[index].dir === "desc" ? ArrowDownIcon : ArrowUpIcon;

  return (
    <button
      type="button"
      onClick={(e) => toggleSort(field, e.shiftKey)}
      title={__("Click to add to the sort, again to reverse or remove it. Shift+click to sort by this column only.")}
      className={cn("group/sort inline-flex max-w-full items-center gap-1 hover:text-foreground", active && "text-foreground")}
    >
      <span className="truncate">{label}</span>
      <SortIcon className={cn("h-3.5 w-3.5 shrink-0", !active && "opacity-0 group-hover/sort:opacity-60")} />
      {active && sort.length > 1 && <span className="text-xs tabular-nums leading-none">{index + 1}</span>}
    </button>
  );
}

/** Right edge of a header cell: drag to resize the column, double click to go back to its natural width. */
function ResizeHandle({ columnKey, onLive, onResize }) {
  const drag = useRef(null);

  const widthAt = (e) => Math.max(MIN_COLUMN_WIDTH, Math.round(drag.current.width + e.clientX - drag.current.x));

  return (
    <span
      role="separator"
      aria-orientation="vertical"
      className="absolute right-0 top-0 z-10 h-full w-1.5 cursor-col-resize touch-none select-none hover:bg-primary/50 active:bg-primary"
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={() => onResize(columnKey, null)}
      onPointerDown={(e) => {
        // Not a column drag (reorder) nor a sort click.
        e.preventDefault();
        e.stopPropagation();
        drag.current = { x: e.clientX, width: e.currentTarget.parentElement.getBoundingClientRect().width, moved: false };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        drag.current.moved = true;
        onLive({ key: columnKey, width: widthAt(e) });
      }}
      onPointerUp={(e) => {
        if (!drag.current) return;
        const { moved } = drag.current;
        const width = widthAt(e);
        drag.current = null;
        onLive(null);
        if (moved) onResize(columnKey, width);
      }}
    />
  );
}

/** Header cell that can be dragged sideways to reorder its column. */
function SortableHeadCell({ id, className, style, ...props }) {
  const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({ id });

  return (
    <TableCell
      ref={setNodeRef}
      {...props}
      {...listeners}
      className={cn(className, isDragging && "z-20 bg-muted opacity-80")}
      style={{
        ...style,
        transform: transform ? `translate3d(${Math.round(transform.x)}px, 0, 0)` : undefined,
        transition,
      }}
    />
  );
}

/**
 * Columns: `{ data: { name, label }, render, headProps, cellProps }` plus, for
 * server lists, `sortable` (`sortField`), `width` (px, stored under `widthKey`
 * or the name), `resizable` and `reorderable`. `onResize(key, width | null)`
 * and `onReorder(fromName, toName)` enable resizing and drag-reordering.
 */
export function SimpleTable(props) {
  const {baseColumns, tableId, sort, toggleSort} = useTable();
  const rows = props.rows || useTable().rows || [];
  const { onResize, onReorder } = props;

  const mappedColumns = useMemo(() => {
    return props.columns || baseColumns;
  }, [baseColumns, props.columns]);

  const availableColumns = useMemo(() => {
    return mappedColumns
  }, [mappedColumns]);

  // Width of the column being resized, while the pointer is down.
  const [liveWidth, setLiveWidth] = useState(null);
  const keyOf = (col) => col.widthKey || col.data?.name;
  const widthOf = (col) => (liveWidth && liveWidth.key === keyOf(col) ? liveWidth.width : col.width);

  // A short move still clicks (sort); a longer one drags the column.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const reorderable = onReorder ? availableColumns.filter((c) => c.reorderable && c.data?.label).map((c) => c.data.name) : [];

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
              const width = widthOf(col);

              return (
                <TableCell
                  key={`${data.name}_${index}`}
                  {...cellProps}
                  className={cn("align-middle", cellProps.className, width && "truncate")}
                  style={width ? { ...cellProps.style, ...widthStyle(width) } : cellProps.style}
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

  const table = (
    <Table 
      aria-label={__("sticky table")} 
      className="w-full overflow-hidden"
    >
      <TableHeader className="bg-muted/40">
        <TableRow className="[&>td]:h-10 [&>td]:py-2 [&>td]:text-sm [&>td]:font-medium [&>td]:text-muted-foreground">
          {availableColumns.filter(c => c.data?.label).map((c) => {
            const { data, headProps = {} } = c;
            const sortField = c.sortField || data.name;
            const sorted = c.sortable && toggleSort ? sort.find((s) => s.field === sortField) : null;
            const width = widthOf(c);
            const canResize = !!(c.resizable && onResize);
            const canReorder = reorderable.includes(data.name);
            const Cell = canReorder ? SortableHeadCell : TableCell;

            return (
              <Cell
                key={data.name}
                {...(canReorder ? { id: data.name } : {})}
                aria-sort={sorted ? (sorted.dir === "desc" ? "descending" : "ascending") : undefined}
                {...headProps}
                className={cn(headProps.className, canResize && "relative", canReorder && "cursor-grab active:cursor-grabbing", width && "truncate")}
                style={width ? { ...headProps.style, ...widthStyle(width) } : headProps.style}
              >
                <HeadLabel col={c} sort={sort || []} toggleSort={toggleSort} />
                {canResize && <ResizeHandle columnKey={keyOf(c)} onLive={setLiveWidth} onResize={onResize} />}
              </Cell>
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

  if (!onReorder) return table;

  return (
    <DndContext
      id={`list-columns-${tableId}`}
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={({ active, over }) => {
        if (over && active.id !== over.id) onReorder(active.id, over.id);
      }}
    >
      <SortableContext items={reorderable} strategy={horizontalListSortingStrategy}>
        {table}
      </SortableContext>
    </DndContext>
  );
}
