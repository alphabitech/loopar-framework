import { useCallback, useEffect, useMemo, useState } from "react";
import loopar, { useRealtime } from "loopar";
import {
  DndContext, DragOverlay, PointerSensor, pointerWithin, useDraggable, useDroppable, useSensor, useSensors,
} from "@dnd-kit/core";
import { ChevronRightIcon, ChevronsDownUpIcon, ChevronsUpDownIcon, CheckIcon, CornerLeftUpIcon, Loader2, PlusIcon } from "lucide-react";
import { Link } from "@link";
import { Button } from "@cn/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@cn/components/ui/table";
import { cn } from "@cn/lib/utils";
import { EntryModal } from "@app/entry-modal";
import { useWorkspace } from "@workspace/workspace-provider";
import { useViewOptions } from "@loopar/document";
import { usePersist } from "@services/persist-state";
import { canOn } from "@context/auth-context";
import { useTable } from "@@table/TableContext";
import { TableSearch } from "@@table/TableSearch";
import { ListFilters } from "@@table/ListFilters";
import { RowMenu } from "@@table/RowMenu";
import { recordLink } from "@@table/record-link";
import { titleFieldsOf } from "@@table/list-columns";
import { listFields, summableFields } from "@@table/list-fields";
import { queryOf } from "@@table/list-url";
import { resolveListColumns } from "@global/list-settings";
import { parseOptionLines } from "@global/select-options";
import { multipleValues } from "@global/element-definition";
import { REPORT_PARAMS } from "@global/list-report";
import { buildTree, canMoveUnder, withAncestors, flattenTree, branchTotals } from "@global/tree";
import { formatDate, formatDateTime, formatCurrency, formatNumber } from "@global/format";
import { __ } from "@global/i18n";
import { treeOf } from "./views";

/**
 * Tree view for entities that nest (global/tree.js): the list's records as
 * an outline, each under the one its parent field names. The whole tree
 * loads at once (`{Entity}/tree`); branches fold, and what is folded is
 * remembered per user. Dropping a record on another hangs it from it (a
 * plain `update` of the parent field); a record never goes under itself or
 * under one below it. Numeric columns add up along the branch: a parent
 * shows its own value plus everything below. Records open in a modal: trees
 * are mostly short catalogs, edited without leaving the outline.
 *
 * With filters the tree keeps the records they match and the ones above
 * them (dimmed), so every match stays in its place.
 */

const ROOT = "__root__";
const INDENT = 20;
const truthy = (value) => [1, "1", true, "true"].includes(value);
const blank = (value) => value === null || value === undefined || value === "";

/** A cell as the list shows it: regional formats, option labels and linked titles. */
function cellOf(col, row) {
  const name = col.data.name;
  const value = row[name];
  if (["switch", "checkbox"].includes(col.element)) {
    return truthy(value)
      ? <CheckIcon className="mx-auto size-4 text-green-500" aria-label={__("Yes")} />
      : <span className="text-muted-foreground" aria-label={__("No")}>—</span>;
  }
  if (blank(value)) return "";
  if (col.element === "date") return formatDate(value, "short");
  if (col.element === "date_time") return formatDateTime(value, "short");
  if (["select", "radio_group"].includes(col.element) && typeof col.data.options === "string") {
    const labels = Object.fromEntries(parseOptionLines(col.data.options).map((o) => [o.value, o.label]));
    return truthy(col.data.multiple)
      ? multipleValues(value).map((v) => __(labels[v] ?? v)).join(", ")
      : __(labels[value] ?? value);
  }
  return String(row.__titles__?.[name] ?? value);
}

const amount = (value, format) => (format === "currency" ? formatCurrency(value) : formatNumber(value, { maximumFractionDigits: 2 }));

function RootDrop({ active }) {
  const { setNodeRef, isOver } = useDroppable({ id: ROOT, disabled: !active });
  if (!active) return null;
  return (
    <div
      ref={setNodeRef}
      className={cn(
        // Floats over the page: showing it must not push the rows being aimed at.
        "fixed inset-x-0 bottom-6 z-50 mx-auto flex w-fit items-center gap-2 rounded-full border border-dashed bg-popover px-5 py-3 text-sm text-muted-foreground shadow-lg transition-colors",
        isOver && "border-primary bg-primary text-primary-foreground"
      )}
    >
      <CornerLeftUpIcon className="size-4" />
      {__("Drop here to move it to the top level")}
    </div>
  );
}

function Row({ node, row, title, columns, totals, sums, dimmed, movable, accepts, dragging, onToggle, onAddChild, onOpen, Entity, portal, onDelete }) {
  const drag = useDraggable({ id: row.name, data: { row }, disabled: !movable });
  const drop = useDroppable({ id: row.name, disabled: !dragging || !accepts });
  const ref = (el) => { drag.setNodeRef(el); drop.setNodeRef(el); };
  const showName = String(title).toLowerCase() !== String(row.name).toLowerCase();

  return (
    <TableRow
      ref={ref}
      className={cn(
        // A tree reads by its indentation: compact rows, no rules between them.
        "group border-0",
        drag.isDragging && "opacity-40",
        dragging && !accepts && !drag.isDragging && "opacity-50",
        dragging && accepts && drop.isOver && "bg-primary/10 ring-2 ring-inset ring-primary/40"
      )}
    >
      <TableCell className="py-0">
        <div className="flex min-w-0 items-center gap-1" style={{ paddingLeft: node.depth * INDENT }}>
          {node.hasChildren ? (
            <Button
              variant="ghost"
              className="size-6 shrink-0 p-0"
              onClick={() => onToggle(row.name)}
              aria-expanded={node.open}
              aria-label={node.open ? __("Collapse") : __("Expand")}
            >
              <ChevronRightIcon className={cn("size-4 transition-transform", node.open && "rotate-90")} />
            </Button>
          ) : <span className="size-6 shrink-0" />}
          <div
            {...(movable ? drag.listeners : {})}
            {...(movable ? drag.attributes : {})}
            className={cn("flex min-w-0 flex-1 items-center", movable && "cursor-grab", dimmed && "opacity-60")}
          >
            <Link
              to={recordLink(Entity, row.name, row, { portal })}
              renderOnRestrict={true}
              // Edits in place (modal); without it the link opens the record's page.
              onClick={onOpen ? () => onOpen(row) : undefined}
              className="flex h-auto min-w-0 flex-col items-start justify-center gap-0 p-0 leading-tight hover:underline"
            >
              <span className={cn("truncate text-foreground", node.hasChildren ? "font-semibold" : "font-medium")}>{title}</span>
              {showName && <span className="truncate text-xs text-muted-foreground">{row.name}</span>}
            </Link>
          </div>
        </div>
      </TableCell>
      {columns.map((col) => {
        const name = col.data.name;
        const summed = sums[name];
        if (summed) {
          const own = Number(row[name]) || 0;
          const total = totals?.[name] ?? own;
          const rolled = node.hasChildren && total !== own;
          return (
            <TableCell
              key={name}
              className={cn("py-0 text-right align-middle tabular-nums", node.hasChildren && "font-semibold", dimmed && "opacity-60")}
              title={rolled ? __("Own: {0}", [amount(own, summed.format)]) : undefined}
            >
              {node.hasChildren || !blank(row[name]) ? amount(total, summed.format) : ""}
            </TableCell>
          );
        }
        return (
          <TableCell key={name} className={cn("max-w-64 truncate py-0 align-middle", col.numeric && "text-right tabular-nums", dimmed && "opacity-60")}>
            {cellOf(col, row)}
          </TableCell>
        );
      })}
      <TableCell className="w-24 py-0 pr-2 text-right align-middle">
        <div className="flex items-center justify-end">
          {onAddChild && (
            <Button
              variant="ghost"
              className={cn(
                "size-8 p-0",
                "[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 focus-visible:opacity-100"
              )}
              onClick={() => onAddChild(row)}
              title={__("New under {0}", [title])}
              aria-label={__("New under {0}", [title])}
            >
              <PlusIcon />
            </Button>
          )}
          <RowMenu row={row} Entity={Entity} onDelete={onDelete} onEdit={onOpen} />
        </div>
      </TableCell>
    </TableRow>
  );
}

export function TreeView({ ctrl }) {
  const Document = ctrl.Document;
  const Entity = Document.Entity;
  const entity = Entity?.name;
  const tree = treeOf(Document);
  const parent = tree?.parent;
  const { pathname: currentUrl, workspace } = useWorkspace();
  const { baseColumns, search, listSettings, deleteRow } = useTable();
  const { hasSearchForm = true } = useViewOptions();
  const portal = workspace === "portal";

  const [state, setState] = useState({ loading: true, data: null, issue: null });
  const [tick, setTick] = useState(0);
  const [active, setActive] = useState(null);
  const [opened, setOpened] = useState(null);
  // Branches are open unless the user folded them.
  const [folded, setFolded] = usePersist(`${entity}_treeFolded`, []);

  // The list's filters live in the URL: the tree applies the same ones.
  const filters = useMemo(() => {
    const params = queryOf(currentUrl);
    ["page", "sort", "preloaded", "workspace", ...REPORT_PARAMS].forEach((key) => params.delete(key));
    return params.toString();
  }, [currentUrl]);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  useRealtime(`${entity}.changed`, reload);

  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    loopar.call(entity, "tree", { query: Object.fromEntries(new URLSearchParams(filters)), freeze: false })
      .then((data) => alive && setState({ loading: false, data, issue: null }))
      .catch((e) => alive && setState({ loading: false, data: null, issue: e?.message || String(e) }));
    return () => { alive = false; };
  }, [entity, filters, tick]);

  const titleFields = useMemo(() => titleFieldsOf(Entity), [Entity]);
  const titleOf = useCallback((row) =>
    titleFields.map((f) => row.__titles__?.[f] ?? row[f]).filter((v) => !blank(v)).join(" ") || row.name, [titleFields]);

  // The list's columns (the user's order and hidden ones), without what the outline already says.
  const columns = useMemo(() => {
    const visible = resolveListColumns(baseColumns(), listSettings)
      .filter((col) => col.data?.name && !["name", parent, ...titleFields].includes(col.data.name));
    const kinds = Object.fromEntries(listFields(visible).map((f) => [f.name, f]));
    return visible.map((col) => ({ ...col, numeric: kinds[col.data.name]?.kind === "number" }));
  }, [baseColumns, listSettings, parent, titleFields]);

  const sums = useMemo(
    () => Object.fromEntries(summableFields(listFields(columns)).map((f) => [f.name, f])),
    [columns]
  );

  const rows = state.data?.rows;
  const built = useMemo(() => buildTree(rows || [], parent), [rows, parent]);
  const matches = useMemo(() => (state.data?.matches ? new Set(state.data.matches) : null), [state.data?.matches]);
  const visible = useMemo(() => (matches ? withAncestors(built.byName, parent, matches) : null), [built, parent, matches]);
  const foldedSet = useMemo(() => new Set(Array.isArray(folded) ? folded : []), [folded]);

  const nodes = useMemo(() => {
    // A filtered tree shows every match: nothing stays folded.
    if (visible) return flattenTree(built, { visible });
    const expanded = new Set(Object.keys(built.children).filter((name) => !foldedSet.has(name)));
    return flattenTree(built, { expanded });
  }, [built, visible, foldedSet]);

  const totals = useMemo(() => branchTotals(built, Object.keys(sums), visible), [built, sums, visible]);

  const toggle = useCallback((name) => {
    const next = new Set(foldedSet);
    next.has(name) ? next.delete(name) : next.add(name);
    // Only records that still exist are worth remembering.
    setFolded([...next].filter((n) => built.byName[n]));
  }, [foldedSet, setFolded, built]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const canCreate = !Entity.read_only && canOn(entity, "create");
  const movable = (row) => !!tree?.editable && !Entity.read_only && !visible && canOn(entity, "update", row);

  const move = (row, target) => {
    const above = target === ROOT ? null : target;
    if ((row[parent] || null) === above) return;
    // Shown at once; the server has the last word.
    setState((s) => (s.data ? { ...s, data: { ...s.data, rows: s.data.rows.map((r) => (r.name === row.name ? { ...r, [parent]: above } : r)) } } : s));
    if (above && foldedSet.has(above)) setFolded([...foldedSet].filter((n) => n !== above));
    loopar.call(entity, "update", {
      query: { name: row.name },
      body: { [parent]: above ?? "" },
      freeze: false,
      success: reload,
      error: reload,
    });
  };

  const onDragEnd = ({ active: a, over }) => {
    setActive(null);
    const row = a?.data?.current?.row;
    if (!row || !over) return;
    if (over.id !== ROOT && !canMoveUnder(built.children, row.name, over.id)) return;
    move(row, over.id);
  };

  const closeModal = () => { setOpened(null); reload(); };
  const addChild = canCreate
    ? (row) => setOpened(`/desk/${entity}/create?${new URLSearchParams({ [parent]: row.name }).toString()}`)
    : null;

  // Records the user may edit open in a modal; the rest follow their link (view).
  const openRecord = !portal && !Entity.read_only
    ? (row) => setOpened(`/desk/${entity}/update?name=${encodeURIComponent(row.name)}`)
    : null;

  if (!tree) return null;

  const branches = Object.keys(built.children).filter((name) => built.children[name].length);
  const allFolded = branches.length > 0 && branches.every((name) => foldedSet.has(name));
  const firstLabel = baseColumns().find((col) => col.data?.name === titleFields[0])?.data?.label || "Name";

  return (
    <DndContext
      sensors={sensors}
      // The row under the pointer is the target, wherever the dragged row was grabbed.
      collisionDetection={pointerWithin}
      onDragStart={({ active: a }) => setActive(a?.data?.current?.row || null)}
      onDragCancel={() => setActive(null)}
      onDragEnd={onDragEnd}
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">{hasSearchForm && <TableSearch onChange={search} />}</div>
          <ListFilters />
          {!visible && branches.length > 0 && (
            <Button
              variant="secondary"
              className="px-2"
              onClick={() => setFolded(allFolded ? [] : branches)}
              title={allFolded ? __("Expand all") : __("Collapse all")}
            >
              {allFolded ? <ChevronsUpDownIcon /> : <ChevronsDownUpIcon />}
              <span className="lp-menu-label pl-1">{allFolded ? __("Expand all") : __("Collapse all")}</span>
            </Button>
          )}
        </div>

        {state.data?.truncated && (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
            {__("This tree has more records than it can show ({0}). The rest is in the list view.", [formatNumber(rows.length)])}
          </div>
        )}

        <RootDrop active={!!active && !blank(active[parent])} />

        {state.issue ? (
          <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">{state.issue}</div>
        ) : !state.data ? (
          <div className="flex justify-center py-10"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>
        ) : nodes.length === 0 ? (
          <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
            {matches ? __("No records match these filters.") : __("No records yet.")}
          </div>
        ) : (
          <div className={cn("overflow-x-auto rounded-xl border", state.loading && "opacity-70")}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{__(firstLabel)}</TableHead>
                  {columns.map((col) => (
                    <TableHead key={col.data.name} className={cn((col.numeric || sums[col.data.name]) && "text-right")}>
                      {__(col.data.label || col.data.name)}
                    </TableHead>
                  ))}
                  <TableHead className="w-24"><span className="sr-only">{__("Actions")}</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {nodes.map((node) => {
                  const row = built.byName[node.name];
                  return (
                    <Row
                      key={row.name}
                      node={node}
                      row={row}
                      title={titleOf(row)}
                      columns={columns}
                      sums={sums}
                      totals={totals[row.name]}
                      dimmed={!!matches && !matches.has(row.name)}
                      movable={movable(row)}
                      dragging={!!active}
                      accepts={!!active && canMoveUnder(built.children, active.name, row.name) && (active[parent] || null) !== row.name}
                      onToggle={toggle}
                      onAddChild={addChild}
                      onOpen={openRecord && canOn(entity, "update", row) ? openRecord : null}
                      Entity={Entity}
                      portal={portal}
                      onDelete={(r) => deleteRow(r, true)}
                    />
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}

        {state.data && nodes.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {matches
              ? __("{0} of {1} records match", [formatNumber(matches.size), formatNumber(rows.length)])
              : __("{0} records", [formatNumber(rows.length)])}
          </p>
        )}
      </div>

      {opened && <EntryModal initialPath={opened} onClose={closeModal} onSaved={closeModal} />}
      <DragOverlay>
        {active ? (
          <div className="inline-flex max-w-xs cursor-grabbing items-center rounded-lg border bg-card px-3 py-1.5 text-sm font-medium shadow-lg">
            <span className="truncate">{titleOf(active)}</span>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
