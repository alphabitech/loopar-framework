import { Fragment, useMemo } from "react";
import { Pagination } from "@pagination";
import loopar from "loopar";
import { Link } from "@link";
import { Checkbox } from "@cn/components/ui/checkbox";
import { Card } from "@cn/components/ui/card";
import { cn } from "@cn/lib/utils";
import { DynamicIcon } from "@icon-input";
import { CheckIcon } from "lucide-react";

import { useTable } from "./TableContext";
import { useViewOptions } from "@loopar/document";
import { TableSearch } from "./TableSearch";
import { EmptyTable } from "./EmptyTable";
import { DropdownListGridActions } from "./DropdownListGridActions";
import { RowMenu } from "./RowMenu.jsx";

const MAX_DETAILS = 4;

const isEmpty = (v) => v === null || v === undefined || v === "";

/** Compact, type-aware rendering of a list column value inside a card. */
function DetailValue({ col, value }) {
  if ([SWITCH, CHECKBOX].includes(col.element)) {
    return loopar.utils.trueValue(value)
      ? <CheckIcon className="h-3.5 w-3.5 text-emerald-500" aria-label="Yes" />
      : <span className="text-muted-foreground" aria-label="No">—</span>;
  }
  if (col.element === ICON_INPUT) {
    return isEmpty(value) ? <span className="text-muted-foreground">—</span> : <DynamicIcon className="h-4 w-4" icon={value} />;
  }
  if (isEmpty(value)) return <span className="text-muted-foreground">—</span>;
  return <span className="truncate" title={String(value)}>{String(value)}</span>;
}

/** Default card used when the view doesn't provide its own `gridTemplate`. */
function GridCard({ row, titleFields, detailCols, iconCol, selected, onSelect, Entity, onDelete }) {
  const title = titleFields.map((f) => row[f]).filter((v) => !isEmpty(v)).join(" ") || row.name;
  const showName = String(title).toLowerCase() !== String(row.name).toLowerCase();
  const icon = iconCol ? row[iconCol.data.name] : null;
  const tag = row.type || row.module;

  return (
    <Card
      className={cn(
        "group relative flex h-full min-w-0 flex-col p-4 transition-colors hover:border-foreground/20",
        selected && "border-primary/60 ring-1 ring-primary/40"
      )}
    >
      <div className="flex items-start gap-3">
        <div
          className="relative flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg text-white ring-1 ring-inset ring-white/10"
          style={{ backgroundColor: loopar.bgColor(row.name) }}
        >
          {icon
            ? <DynamicIcon className="h-5 w-5" icon={icon} />
            : <span className="text-base font-semibold">{loopar.utils.avatar(String(title))}</span>}
          {/* Selection checkbox sits on the avatar: visible on hover, when selected, or on touch devices. */}
          <span
            className={cn(
              "absolute -left-1.5 -top-1.5 rounded bg-card transition-opacity",
              selected ? "opacity-100" : "[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 focus-within:opacity-100"
            )}
          >
            <Checkbox className="h-4 w-4" checked={selected} onCheckedChange={onSelect} aria-label={`Select ${row.name}`} />
          </span>
        </div>

        <div className="min-w-0 flex-1">
          <Link
            to={`update?name=${encodeURIComponent(row.name)}`}
            renderOnRestrict={true}
            bare
            className="block truncate font-medium leading-tight text-foreground hover:underline"
          >
            {title}
          </Link>
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            {showName && <span className="truncate font-mono">{row.name}</span>}
            {showName && tag && <span className="text-border">•</span>}
            {tag && <span className="truncate">{tag}</span>}
          </div>
        </div>

        <div className="-mr-2 -mt-1 flex-shrink-0">
          <RowMenu row={row} Entity={Entity} onDelete={onDelete} />
        </div>
      </div>

      {detailCols.length > 0 && (
        <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 border-t border-border/60 pt-3 text-xs">
          {detailCols.map((col) => (
            <Fragment key={col.data.name}>
              <dt className="truncate text-muted-foreground">{col.data.label || col.data.name}</dt>
              <dd className="flex min-w-0 items-center text-foreground/90">
                <DetailValue col={col} value={row[col.data.name]} />
              </dd>
            </Fragment>
          ))}
        </dl>
      )}
    </Card>
  );
}

export function GridView(props) {
  const {
    selectedRows,
    selectRow,
    search,
    deleteRow,
    baseColumns,
    Document,
  } = useTable();

  const { hasSearchForm, hasSelectAll, gridTemplate, gridMinWidth = "22rem" } = useViewOptions();

  const rows = props.rows || useTable().rows || [];
  const Entity = Document?.Entity || {};

  const titleFields = useMemo(
    () => String(Entity.title_fields || "").split(",").map((s) => s.trim()).filter(Boolean),
    [Entity.title_fields]
  );

  // Same columns the list view shows (in_list_view), minus name/title; icon fields feed the avatar.
  const { detailCols, iconCol } = useMemo(() => {
    if (gridTemplate) return { detailCols: [], iconCol: null };
    const cols = baseColumns().filter((col) =>
      !col.isCustom &&
      col.data?.name &&
      col.data.name !== "name" &&
      loopar.utils.trueValue(col.data.in_list_view)
    );
    const iconCol = cols.find((col) => col.element === ICON_INPUT) || null;
    return {
      iconCol,
      detailCols: cols.filter((col) => col !== iconCol && !titleFields.includes(col.data.name)).slice(0, MAX_DETAILS),
    };
  }, [baseColumns, titleFields, gridTemplate]);

  const defaultAction = (row) => {
    if (["Entity", "Builder", "Contact Form Builder"].includes(row.type || "")) {
      return row.is_single ? "update" : "list";
    }
    if (["Page Builder", "View Builder", "Desk Page Builder"].includes(row.type)) return "view";
    return "";
  };

  const showToolbar = hasSelectAll !== false || hasSearchForm !== false;

  return (
    <>
      {showToolbar && (
        <div className="mb-4 flex items-start gap-2">
          {hasSelectAll !== false && <DropdownListGridActions deleteOnServer={true}/>}
          {hasSearchForm !== false && (
            <div className="min-w-0 flex-1">
              <TableSearch onChange={search} />
            </div>
          )}
        </div>
      )}
      <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${gridMinWidth}), 1fr))` }}>
        {rows.length ? rows.map((row) => (
          gridTemplate ? (
            <Fragment key={row.name}>{gridTemplate(row, defaultAction(row))}</Fragment>
          ) : (
            <GridCard
              key={row.name}
              row={row}
              Entity={Entity}
              titleFields={titleFields}
              detailCols={detailCols}
              iconCol={iconCol}
              selected={selectedRows.includes(row.name)}
              onSelect={(checked) => selectRow(row, checked)}
              onDelete={(r) => deleteRow(r, true)}
            />
          )
        )) : (
          <div className="col-span-full flex w-full items-center justify-center p-4">
            <EmptyTable />
          </div>
        )}
      </div>
      <div className="mt-3">
        <Pagination/>
        {props.footer}
      </div>
    </>
  );
}
