import { useCallback, useEffect, useMemo, useState } from "react";
import loopar from "loopar";
import {
  DndContext, DragOverlay, PointerSensor, KeyboardSensor, useDraggable, useDroppable, useSensor, useSensors,
} from "@dnd-kit/core";
import { Loader2 } from "lucide-react";
import { Button } from "@cn/components/ui/button";
import { cn } from "@cn/lib/utils";
import { STATE_COLORS, runTransition } from "../form/workflow-bar";
import { EntryModal } from "@app/entry-modal";

/**
 * Kanban board for entities with an active workflow: one column per state
 * (`show_on_board`), cards = records. Dropping a card on another column runs
 * the transition that joins both states; columns without one (for this user)
 * don't accept the drop. Data per column comes from `{Entity}/list?board=`.
 */

const PAGE = 20;
const titleOf = (row, titleFields) =>
  (titleFields || []).map((f) => row[f]).filter((v) => v !== null && v !== undefined && v !== "").join(" - ") || row.name;

/** Transition that moves a card from `from` to `to`, or null. */
function transitionFor(board, states, from, to) {
  if (from === to) return null;
  const fromFinal = states.find((s) => s.state === from)?.is_final;
  return (board || []).find((t) => t.to === to && (t.from.includes(from) || (t.from.includes("*") && !fromFinal))) || null;
}

function CardView({ row, title, details, className, ...rest }) {
  return (
    <div
      {...rest}
      className={cn("select-none rounded-lg border bg-card p-3 text-card-foreground shadow-sm", className)}
    >
      <p className="truncate text-sm font-medium">{title}</p>
      {details.length > 0 && (
        <div className="mt-1 space-y-0.5">
          {details.map(([label, value]) => (
            <p key={label} className="truncate text-xs text-muted-foreground">
              <span className="text-foreground/70">{label}:</span> {String(value)}
            </p>
          ))}
        </div>
      )}
      {title !== row.name && <p className="mt-1.5 text-[11px] text-muted-foreground">{row.name}</p>}
    </div>
  );
}

function Card({ row, title, details, entity }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: row.name, data: { row } });
  const open = () => loopar.navigate(`/desk/${entity}/update?name=${encodeURIComponent(row.name)}`);

  return (
    <CardView
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onClick={open}
      row={row}
      title={title}
      details={details}
      className={cn("cursor-grab transition-shadow hover:shadow-md", isDragging && "opacity-40")}
    />
  );
}

function Column({ state, data, accepts, dragging, children, onMore }) {
  const { setNodeRef, isOver } = useDroppable({ id: state.state, disabled: dragging && !accepts });
  const canDrop = dragging && accepts;

  return (
    <div className="flex w-72 shrink-0 flex-col rounded-xl border bg-muted/30">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium",
          STATE_COLORS[state.color] || STATE_COLORS.gray)}>
          <span className="size-1.5 rounded-full bg-current" />
          {state.state}
        </span>
        <span className="text-xs text-muted-foreground">{data?.total ?? "…"}</span>
      </div>
      <div
        ref={setNodeRef}
        className={cn(
          "flex min-h-24 flex-1 flex-col gap-2 p-2 transition-colors",
          canDrop && "bg-primary/5",
          canDrop && isOver && "bg-primary/15 ring-2 ring-primary/40 ring-inset rounded-b-xl",
          dragging && !accepts && "opacity-50"
        )}
      >
        {children}
        {!data && (
          <div className="flex justify-center py-4"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
        )}
        {data && data.rows.length < data.total && (
          <Button variant="ghost" size="sm" onClick={onMore} disabled={data.loading}>
            {data.loading ? "Loading…" : `Show more (${data.total - data.rows.length})`}
          </Button>
        )}
      </div>
    </div>
  );
}

export function KanbanBoard({ ctrl }) {
  const Document = ctrl.Document;
  const entity = Document.Entity?.name;
  const workflow = Document.workflow;
  const states = useMemo(() => (workflow?.states || []).filter((s) => s.show_on_board !== false), [workflow]);
  const titleFields = useMemo(
    () => String(Document.Entity?.title_fields || "").split(",").map((s) => s.trim()).filter(Boolean),
    [Document.Entity?.title_fields]
  );
  // Up to three list columns as card details (not the state, not the title).
  const detailFields = useMemo(() => {
    const fields = Document.fields || [];
    const labels = Document.labels || [];
    return fields
      .map((f, i) => [f, labels[i] || f])
      .filter(([f]) => f !== "name" && f !== workflow?.field && !titleFields.includes(f))
      .slice(0, 3);
  }, [Document.fields, Document.labels, workflow?.field, titleFields]);

  const [columns, setColumns] = useState({});
  const [active, setActive] = useState(null);
  const [opened, setOpened] = useState(null);

  const load = useCallback((state, page = 1) => {
    setColumns((c) => ({ ...c, [state]: c[state] ? { ...c[state], loading: true } : c[state] }));
    loopar.call(entity, "list", { query: { board: state, page }, freeze: false })
      .then((r) => setColumns((c) => ({
        ...c,
        [state]: {
          rows: page > 1 ? [...(c[state]?.rows || []), ...(r?.rows || [])] : r?.rows || [],
          total: r?.total ?? 0,
          page,
          loading: false,
        },
      })))
      .catch(() => setColumns((c) => ({ ...c, [state]: { rows: [], total: 0, page: 1, loading: false } })));
  }, [entity]);

  useEffect(() => {
    states.forEach((s) => load(s.state));
  }, [states, load]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor)
  );

  const onDragEnd = ({ active: a, over }) => {
    setActive(null);
    const row = a?.data?.current?.row;
    if (!row || !over) return;
    const from = row[workflow.field];
    const t = transitionFor(workflow.board, workflow.states, from, over.id);
    if (!t) return;
    runTransition({
      entity,
      name: row.name,
      transition: t,
      docStructure: Document.Entity?.doc_structure,
      current: row,
      onDone: () => { load(from); load(over.id); },
      onOpen: (path) => { load(from); load(over.id); setOpened(path); },
    });
  };

  if (!workflow) return null;
  if (!states.length) {
    return (
      <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
        The workflow of {entity} has no states to show on the board.
      </div>
    );
  }

  const details = (row) => detailFields
    .map(([f, label]) => [label, row[f]])
    .filter(([, v]) => v !== null && v !== undefined && v !== "");

  const from = active?.[workflow.field];

  return (
    <DndContext
      sensors={sensors}
      onDragStart={({ active: a }) => setActive(a?.data?.current?.row || null)}
      onDragCancel={() => setActive(null)}
      onDragEnd={onDragEnd}
    >
      <div className="flex min-w-0 gap-3 overflow-x-auto pb-4">
        {states.map((s) => (
          <Column
            key={s.state}
            state={s}
            data={columns[s.state]}
            dragging={!!active}
            accepts={!!active && !!transitionFor(workflow.board, workflow.states, from, s.state)}
            onMore={() => load(s.state, (columns[s.state]?.page || 1) + 1)}
          >
            {(columns[s.state]?.rows || []).map((row) => (
              <Card key={row.name} row={row} title={titleOf(row, titleFields)} details={details(row)} entity={entity} />
            ))}
          </Column>
        ))}
      </div>
      {opened && <EntryModal initialPath={opened} onClose={() => setOpened(null)} />}
      <DragOverlay>
        {active ? <CardView row={active} title={titleOf(active, titleFields)} details={details(active)} className="cursor-grabbing shadow-lg" /> : null}
      </DragOverlay>
    </DndContext>
  );
}
