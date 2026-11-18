import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import loopar from "loopar";
import FullCalendar from "@fullcalendar/react";
import themePlugin from "@fullcalendar/react/themes/classic";
import dayGridPlugin from "@fullcalendar/react/daygrid";
import timeGridPlugin from "@fullcalendar/react/timegrid";
import listPlugin from "@fullcalendar/react/list";
import interactionPlugin, { Draggable } from "@fullcalendar/react/interaction";
import esLocale from "@fullcalendar/react/locales/es";
import "@fullcalendar/react/skeleton.css";
import "@fullcalendar/react/themes/classic/theme.css";
import "@fullcalendar/react/themes/classic/palette.css";
import "./calendar-board.css";
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon, LayersIcon, Loader2, UserIcon } from "lucide-react";
import { Button } from "@cn/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@cn/components/ui/dropdown-menu";
import { cn } from "@cn/lib/utils";
import { EntryModal } from "@app/entry-modal";
import { usePersist } from "@services/persist-state";
import { canOn, useAuth } from "@context/auth-context";
import { __ } from "@global/i18n";
import { addDays, dayOf, diffDays, frequencyOf, occurrenceDays, shiftWeekdays } from "@global/calendar";

/**
 * The calendar (FullCalendar): month, week, day and agenda over one or more
 * layers. A layer is an entity with date fields (global/calendar.js); its
 * records come from `{Entity}/list?calendar=range`. Moving or resizing an
 * event is a plain `update` of the record's date fields; picking a slot or
 * an event opens the entity's own form in a modal.
 *
 * Loaded lazily (list/calendar.jsx): the library never reaches the main bundle.
 */

const EVENT = "Event";
const PLUGINS = [themePlugin, dayGridPlugin, timeGridPlugin, listPlugin, interactionPlugin];
const LOCALES = [esLocale];
const VIEWS = [
  ["dayGridMonth", () => __("Month")],
  ["timeGridWeek", () => __("Week")],
  ["timeGridDay", () => __("Day")],
  ["listWeek", () => __("Agenda")],
];
const COLORS = {
  blue: "#3b82f6", amber: "#d97706", green: "#16a34a", red: "#dc2626", violet: "#7c3aed", gray: "#6b7280",
};
// Layers without a state or a calendar take one of these, in order.
const LAYER_COLORS = ["#0891b2", "#7c3aed", "#d97706", "#16a34a", "#db2777", "#6b7280"];

const truthy = (value) => [1, "1", true, "true"].includes(value);
const pad = (n) => String(n).padStart(2, "0");
const ymd = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
/** Stored date-time → `YYYY-MM-DDTHH:mm:ss` (wall clock). */
const iso = (value) => {
  const text = String(value).replace(" ", "T");
  return text.length <= 10 ? `${text.slice(0, 10)}T00:00:00` : text.slice(0, 19);
};
/** FullCalendar's ISO string → the stored `YYYY-MM-DD HH:mm:ss`. */
const stored = (str) => `${str.slice(0, 10)} ${str.length > 10 ? str.slice(11, 19).padEnd(8, ":00") : "00:00:00"}`;

/** Title of what a view shows: the month, the days of the week, or the day. */
function rangeTitle(view) {
  const from = view.currentStart;
  const to = new Date(view.currentEnd.getTime() - 1); // currentEnd is exclusive
  const language = loopar.language || undefined;
  if (view.type.startsWith("dayGridMonth")) return new Intl.DateTimeFormat(language, { month: "long", year: "numeric" }).format(from);
  if (ymd(from) === ymd(to)) return new Intl.DateTimeFormat(language, { weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(from);
  return new Intl.DateTimeFormat(language, { month: "short", day: "numeric", year: "numeric" }).formatRange(from, to);
}

/** Users of an `assigned_to` value: a JSON list (multiple) or one name. */
function assignees(value) {
  if (value === null || value === undefined || value === "") return [];
  if (Array.isArray(value)) return value.map(String);
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [String(parsed)];
  } catch {
    return [String(value)];
  }
}

const titleOf = (row, fields) =>
  (fields || []).map((f) => row[f]).filter((v) => v !== null && v !== undefined && v !== "").join(" - ") || row.name;

/**
 * A record of `layer` as FullCalendar events between `from` and `to`: one,
 * or one per repetition when it recurs. None when it has no start (or its
 * calendar is off).
 */
function toEvents(row, layer, meta, calendars, layerColor, from, to) {
  const startDay = dayOf(row[layer.start]);
  if (!startDay) return [];
  const endDay = layer.end ? dayOf(row[layer.end]) : null;
  const allDay = !layer.time || (!!layer.allDay && truthy(row[layer.allDay]));

  let color = layerColor;
  if (layer.entity === EVENT) {
    const calendar = calendars.find((c) => c.name === row.calendar);
    if (calendar?.disabled) return [];
    color = COLORS[calendar?.color] || COLORS.blue;
  } else if (meta?.states && COLORS[meta.states.colors[row[meta.states.field]]]) {
    color = COLORS[meta.states.colors[row[meta.states.field]]];
  }

  const recurring = !!frequencyOf(row, layer);
  const editable = layer.editable && canOn(layer.entity, "update", row);
  const title = titleOf(row, meta?.titleFields);

  return occurrenceDays(row, layer, from, to).map((day) => {
    const shift = diffDays(day, startDay);
    let start, end;
    if (allDay) {
      start = day;
      end = addDays(endDay && endDay > startDay ? endDay : startDay, shift + 1); // exclusive
    } else {
      start = `${day}T${iso(row[layer.start]).slice(11)}`;
      const to_ = layer.end && row[layer.end] ? iso(row[layer.end]) : null;
      end = to_ && to_ > iso(row[layer.start]) ? `${addDays(to_.slice(0, 10), shift)}T${to_.slice(11)}` : undefined;
    }
    return {
      id: recurring ? `${layer.entity}|${row.name}|${day}` : `${layer.entity}|${row.name}`,
      title,
      start,
      end,
      allDay,
      color,
      contrastColor: "#fff",
      startEditable: editable,
      durationEditable: editable && !!layer.end,
      extendedProps: { layer, row, recurring },
    };
  });
}

/** `value` (a day, or `YYYY-MM-DDTHH:mm:ss`) moved by a FullCalendar duration, in the same wall-clock form. */
function moved(value, duration) {
  const dated = value.length <= 10;
  const date = new Date(dated ? `${value}T00:00:00` : value);
  date.setMonth(date.getMonth() + (duration?.years || 0) * 12 + (duration?.months || 0));
  date.setDate(date.getDate() + (duration?.days || 0));
  date.setTime(date.getTime() + (duration?.milliseconds || 0));
  const text = `${ymd(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return dated && !(duration?.milliseconds) ? text.slice(0, 10) : text;
}

/**
 * A recurring record after one of its repetitions was moved or resized: the
 * same change applied to the record itself, so the whole series follows.
 * Shaped like the FullCalendar event `valuesOf` reads.
 */
function seriesAfter(info, layer, row) {
  const startDay = dayOf(row[layer.start]);
  const endDay = layer.end ? dayOf(row[layer.end]) : null;
  const wasAllDay = !layer.time || (!!layer.allDay && truthy(row[layer.allDay]));
  const start = wasAllDay ? startDay : iso(row[layer.start]);
  const end = wasAllDay
    ? addDays(endDay && endDay > startDay ? endDay : startDay, 1)
    : (layer.end && row[layer.end] ? iso(row[layer.end]) : null);

  const startDelta = info.delta || info.startDelta;
  const endDelta = info.delta || info.endDelta;
  // Dropped between the all-day row and the time grid: FullCalendar resets the length.
  const keepsEnd = !!info.event.end && end && info.event.allDay === wasAllDay;
  return {
    allDay: info.event.allDay,
    startStr: moved(start, startDelta),
    end: keepsEnd,
    endStr: keepsEnd ? moved(end, endDelta) : "",
  };
}

/** Field values to store for an event as FullCalendar now shows it, or null when the layer can't hold it. */
function valuesOf(event, layer, row) {
  const start = event.startStr;
  const end = event.end ? event.endStr : null;

  if (!layer.time) {
    const from = start.slice(0, 10);
    const values = { [layer.start]: from };
    if (layer.end) {
      const to = end ? addDays(end.slice(0, 10), event.allDay ? -1 : 0) : from;
      values[layer.end] = to <= from && !dayOf(row[layer.end]) ? null : (to < from ? from : to);
    }
    return values;
  }

  if (event.allDay) {
    if (!layer.allDay) return null;
    const from = start.slice(0, 10);
    const to = end ? addDays(end.slice(0, 10), -1) : from;
    return {
      [layer.start]: `${from} 00:00:00`,
      ...(layer.end ? { [layer.end]: `${to < from ? from : to} 00:00:00` } : {}),
      [layer.allDay]: 1,
    };
  }

  return {
    [layer.start]: stored(start),
    ...(layer.end ? { [layer.end]: end ? stored(end) : null } : {}),
    ...(layer.allDay ? { [layer.allDay]: 0 } : {}),
  };
}

function Toolbar({ api, title, view, onView, loading, layers, hidden, onToggleLayer, mine, onMine }) {
  return (
    <div className="flex flex-wrap items-center gap-2 pb-3">
      <Button variant="secondary" size="sm" onClick={() => api()?.today()}>{__("Today")}</Button>
      <Button variant="ghost" size="icon" className="size-8" onClick={() => api()?.prev()} title={__("Previous")}>
        <ChevronLeftIcon className="size-4" />
      </Button>
      <Button variant="ghost" size="icon" className="size-8" onClick={() => api()?.next()} title={__("Next")}>
        <ChevronRightIcon className="size-4" />
      </Button>
      <h2 className="min-w-0 flex-1 truncate text-base font-semibold first-letter:uppercase">{title}</h2>
      {loading && <Loader2 className="size-4 animate-spin text-muted-foreground" />}

      {onMine && (
        <Button variant={mine ? "default" : "secondary"} size="sm" onClick={onMine} title={__("Only what is assigned to me")} aria-pressed={mine}>
          <UserIcon className="size-4" />
          <span className="pl-1.5">{__("Mine")}</span>
        </Button>
      )}

      {layers.length > 1 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="secondary" size="sm" title={__("Layers")}>
              <LayersIcon className="size-4" />
              <span className="pl-1.5">{__("Layers")}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {layers.map((layer) => (
              <DropdownMenuItem
                key={layer.entity}
                className="gap-2"
                onSelect={(e) => { e.preventDefault(); onToggleLayer(layer.entity); }}
              >
                <span className="size-2.5 rounded-full" style={{ background: layer.color }} />
                <span className="flex-1">{__(layer.entity)}</span>
                <CheckIcon className={cn("size-4 text-muted-foreground", hidden.includes(layer.entity) && "invisible")} />
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      <div className="inline-flex rounded-md border bg-muted/40 p-0.5">
        {VIEWS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => onView(id)}
            className={cn(
              "rounded px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground",
              view === id && "bg-background text-foreground shadow-sm"
            )}
          >
            {label()}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Records of the main layer without a date: dragged onto the calendar to schedule them. */
function Tray({ trayRef, data, active, titleFields, canDrag, onOpen, onMore }) {
  return (
    <div className="flex w-full shrink-0 flex-col rounded-xl border bg-muted/30 lg:w-60">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <span className="text-xs font-medium text-muted-foreground">{__("Unscheduled")}</span>
        <span className="text-xs text-muted-foreground">{data?.total ?? "…"}</span>
      </div>
      <div
        ref={trayRef}
        className={cn("flex min-h-20 flex-1 flex-col gap-1.5 p-2 transition-colors", active && "rounded-b-xl bg-primary/10 ring-2 ring-primary/40 ring-inset")}
      >
        {(data?.rows || []).map((row) => (
          <div
            key={row.name}
            data-unscheduled={canDrag(row) ? row.name : undefined}
            onClick={() => onOpen(row)}
            title={titleOf(row, titleFields)}
            className={cn(
              "select-none truncate rounded-md border bg-card px-2 py-1.5 text-xs font-medium",
              canDrag(row) ? "cursor-grab" : "cursor-pointer"
            )}
          >
            {titleOf(row, titleFields)}
          </div>
        ))}
        {data && data.total === 0 && (
          <p className="px-1 py-2 text-xs text-muted-foreground">{__("Drag a record here to clear its date.")}</p>
        )}
        {data && data.rows.length < data.total && (
          <Button variant="ghost" size="sm" onClick={onMore} disabled={data.loading}>
            {data.loading ? __("Loading…") : __("Show more ({0})", [data.total - data.rows.length])}
          </Button>
        )}
      </div>
    </div>
  );
}

export default function CalendarBoard({ entity, layers: allLayers, calendars = [], filters = "", titleFields = [], weekStart = 0 }) {
  const calendarRef = useRef(null);
  const trayRef = useRef(null);
  const api = useCallback(() => calendarRef.current?.getApi?.(), []);

  const [view, setView] = usePersist(`${entity}_calendarView`, "dayGridMonth");
  const [hiddenLayers, setHiddenLayers] = usePersist(`${entity}_calendarHidden`, null);
  const initialView = useRef(VIEWS.some(([id]) => id === view) ? view : "dayGridMonth").current;

  // "Mine": of the layers that say who a record is for, only the user's own.
  const { userId } = useAuth();
  const [mineOnly, setMineOnly] = usePersist(`${entity}_calendarMine`, false);
  const mine = mineOnly === true || mineOnly === "true";

  const [title, setTitle] = useState("");
  const [loading, setLoading] = useState(false);
  const [opened, setOpened] = useState(null);
  const [tray, setTray] = useState(null);
  const [overTray, setOverTray] = useState(false);
  const [draggingMain, setDraggingMain] = useState(false);

  const layers = useMemo(
    () => allLayers.map((layer, i) => ({ ...layer, color: layer.entity === EVENT ? COLORS.blue : LAYER_COLORS[i % LAYER_COLORS.length] })),
    [allLayers]
  );
  const main = layers.find((l) => l.entity === entity) || layers[0];
  // Until the user picks: ranges (projects, shifts…) show, single dates
  // (a quote's date, a hire date…) wait in the Layers menu.
  const hidden = useMemo(
    () => (Array.isArray(hiddenLayers) ? hiddenLayers : layers.filter((l) => l.entity !== entity && !l.end).map((l) => l.entity)),
    [hiddenLayers, layers, entity]
  );
  // Where a picked slot creates a record: an Event when there are events, else the list's own entity.
  const target = [layers.find((l) => l.entity === EVENT), main].find((l) => l?.creatable) || null;

  const refetch = useCallback(() => api()?.refetchEvents(), [api]);

  // FullCalendar reports these while it renders (even before this component
  // mounts): the state changes right after, or on mount.
  const mounted = useRef(false);
  const pending = useRef({});
  const later = useCallback((key, apply) => {
    if (mounted.current) queueMicrotask(apply);
    else pending.current[key] = apply;
  }, []);
  useEffect(() => {
    mounted.current = true;
    Object.values(pending.current).forEach((apply) => apply());
    pending.current = {};
    return () => { mounted.current = false; };
  }, []);
  const onLoading = useCallback((isLoading) => later("loading", () => setLoading(isLoading)), [later]);
  const onDatesSet = useCallback((info) => { const text = rangeTitle(info.view); later("title", () => setTitle(text)); }, [later]);

  // One event source per visible layer. The list's filters apply to its own entity only.
  const eventSources = useMemo(() => layers.filter((l) => !hidden.includes(l.entity)).map((layer) => ({
    id: layer.entity,
    events: (info, success, failure) => {
      const query = {
        ...(layer.entity === entity ? Object.fromEntries(new URLSearchParams(filters)) : {}),
        cal_from: ymd(info.start),
        cal_to: addDays(ymd(info.end), -1),
      };
      loopar.call(layer.entity, "calendar", { query, freeze: false })
        .then((r) => {
          // The list already knows its own title fields; a layer's come with its rows.
          const meta = { titleFields: r?.titleFields || (layer.entity === entity ? titleFields : []), states: r?.states || null };
          const rows = (r?.rows || []).filter((row) => !mine || !layer.assignee || assignees(row[layer.assignee]).includes(String(userId)));
          success(rows.flatMap((row) => toEvents(row, layer, meta, calendars, layer.color, query.cal_from, query.cal_to)));
        })
        .catch((e) => failure(e instanceof Error ? e : new Error(String(e?.message || e))));
    },
  })), [layers, hidden.join("|"), entity, filters, calendars, titleFields, mine, userId]);

  // Unscheduled tray: only for the list's own entity, when it stores plain dates
  // (an empty date_time is stored as "now", so those always have a date).
  const hasTray = !!main && !main.time;
  const loadTray = useCallback((page = 1) => {
    if (!hasTray) return;
    setTray((t) => (t ? { ...t, loading: true } : t));
    const query = { ...Object.fromEntries(new URLSearchParams(filters)), calendar: "unscheduled", page };
    loopar.call(entity, "calendar", { query, freeze: false })
      .then((r) => setTray((t) => ({
        rows: page > 1 ? [...(t?.rows || []), ...(r?.rows || [])] : r?.rows || [],
        total: r?.total ?? 0,
        page,
        loading: false,
      })))
      .catch(() => setTray({ rows: [], total: 0, page: 1, loading: false }));
  }, [entity, filters, hasTray]);
  useEffect(() => { loadTray(); }, [loadTray]);

  const showTray = hasTray && ((tray?.total || 0) > 0 || draggingMain);
  const canMoveMain = useCallback((row) => !!main?.editable && canOn(entity, "update", row), [main, entity]);

  // Tray cards drag onto the calendar (FullCalendar's external dragging).
  useEffect(() => {
    if (!showTray || !trayRef.current) return;
    const draggable = new Draggable(trayRef.current, { itemSelector: "[data-unscheduled]" });
    return () => draggable.destroy();
  }, [showTray]);

  const save = useCallback((layer, name, values, { onError, onDone } = {}) => {
    loopar.call(layer.entity, "update", {
      query: { name },
      body: values,
      freeze: false,
      success: () => onDone?.(),
      error: () => onError?.(),
    });
  }, []);

  const onChange = (info) => {
    const { layer, row, recurring } = info.event.extendedProps;
    let values = null;
    try {
      values = valuesOf(recurring ? seriesAfter(info, layer, row) : info.event, layer, row);
    } catch (error) {
      // Never leave an event where it was dropped without having stored it.
      console.error("[calendar] could not read the new dates:", error);
    }
    if (!values) return info.revert();
    // A weekly series on chosen days moved to another weekday: its days move with it.
    if (recurring && layer.repeat?.days && frequencyOf(row, layer) === "weekly") {
      const shift = diffDays(dayOf(values[layer.start]), dayOf(row[layer.start]));
      if (shift % 7 !== 0) values[layer.repeat.days] = shiftWeekdays(row[layer.repeat.days], shift);
    }
    // The last day of a series moves with it, so the series keeps its length.
    if (recurring && layer.repeat?.until && dayOf(row[layer.repeat.until])) {
      const shift = diffDays(dayOf(values[layer.start]), dayOf(row[layer.start]));
      if (shift) values[layer.repeat.until] = addDays(dayOf(row[layer.repeat.until]), shift);
    }
    save(layer, row.name, values, {
      onError: () => info.revert(),
      // Every repetition of a series moves with it: draw them again.
      onDone: () => (recurring ? refetch() : info.event.setExtendedProp("row", { ...row, ...values })),
    });
  };

  // A tray card dropped on a day (or a time slot): the record starts there.
  const onDrop = (info) => {
    const name = info.draggedEl?.dataset?.unscheduled;
    if (!name || !main) return;
    save(main, name, { [main.start]: info.dateStr.slice(0, 10) }, {
      onError: () => { refetch(); loadTray(); },
      onDone: () => { refetch(); loadTray(); },
    });
  };

  const insideTray = (jsEvent) => {
    const rect = trayRef.current?.getBoundingClientRect();
    const x = jsEvent?.clientX, y = jsEvent?.clientY;
    return !!rect && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  };

  // An event dropped on the tray loses its dates.
  const onDragStop = (info) => {
    const { layer, row } = info.event.extendedProps;
    setDraggingMain(false);
    setOverTray(false);
    if (!hasTray || layer.entity !== entity || !insideTray(info.jsEvent)) return;
    const values = { [layer.start]: null, ...(layer.end ? { [layer.end]: null } : {}) };
    info.event.remove();
    save(layer, row.name, values, { onError: () => { refetch(); loadTray(); }, onDone: () => loadTray() });
  };

  useEffect(() => {
    if (!draggingMain) return;
    const track = (e) => setOverTray(insideTray(e));
    window.addEventListener("pointermove", track);
    return () => window.removeEventListener("pointermove", track);
  }, [draggingMain]);

  // A picked slot opens the form of a new record, already on those dates.
  const onSelect = (info) => {
    api()?.unselect();
    if (!target) return;
    const params = new URLSearchParams();
    const from = info.startStr.slice(0, 10);
    const to = info.allDay ? addDays(info.endStr.slice(0, 10), -1) : info.endStr.slice(0, 10);

    if (!target.time) {
      params.set(target.start, from);
      if (target.end && to > from) params.set(target.end, to);
    } else if (info.allDay) {
      // A single day picked on the month grid is a visit that day, not a whole-day event.
      const wholeDay = !!target.allDay && (to > from || info.view.type !== "dayGridMonth");
      params.set(target.start, wholeDay ? `${from} 00:00:00` : `${from} 09:00:00`);
      if (wholeDay) {
        if (target.end) params.set(target.end, `${to} 00:00:00`);
        params.set(target.allDay, "1");
      }
    } else {
      params.set(target.start, stored(info.startStr));
      if (target.end) params.set(target.end, stored(info.endStr));
    }
    setOpened(`/desk/${target.entity}/create?${params.toString()}`);
  };

  // Saving (or closing) the form returns to the calendar, redrawn.
  const closeModal = () => { setOpened(null); refetch(); loadTray(); };

  const open = (layerEntity, name) => setOpened(`/desk/${layerEntity}/update?name=${encodeURIComponent(name)}`);

  // FullCalendar rebuilds its context when an option changes, and a drag that
  // crosses a rebuild is dropped as if it came from another calendar (no
  // eventDrop). Its callbacks therefore never change: they call the latest
  // handlers through a ref.
  const handlers = useRef({});
  handlers.current = {
    eventDrop: onChange,
    eventResize: onChange,
    drop: onDrop,
    eventDragStart: (info) => setDraggingMain(info.event.extendedProps.layer?.entity === entity),
    eventDragStop: onDragStop,
    select: onSelect,
    eventClick: (info) => {
      info.jsEvent?.preventDefault();
      const { layer, row } = info.event.extendedProps;
      open(layer.entity, row.name);
    },
  };
  const stable = useMemo(() => ({
    ...Object.fromEntries(Object.keys(handlers.current).map((name) => [name, (info) => handlers.current[name](info)])),
    eventAllow: (span, event) => {
      const layer = event?.extendedProps?.layer;
      if (!layer) return true;
      // Plain dates stay whole days; timed records need an all-day switch to become one.
      return layer.time ? (!span.allDay || !!layer.allDay) : span.allDay;
    },
  }), []);

  const changeView = (id) => {
    setView(id);
    api()?.changeView(id);
  };

  return (
    <div className="lp-calendar flex min-w-0 flex-col gap-3 pb-4 lg:flex-row lg:items-start">
      <div className="min-w-0 flex-1">
        <Toolbar
          api={api}
          title={title}
          view={view}
          onView={changeView}
          loading={loading}
          layers={layers}
          hidden={hidden}
          mine={mine}
          onMine={userId && layers.some((l) => l.assignee) ? () => setMineOnly(!mine) : null}
          onToggleLayer={(name) => setHiddenLayers(hidden.includes(name) ? hidden.filter((n) => n !== name) : [...hidden, name])}
        />
        <div className="overflow-hidden rounded-xl border bg-card">
          <FullCalendar
            ref={calendarRef}
            plugins={PLUGINS}
            locales={LOCALES}
            locale={loopar.language || "en"}
            firstDay={weekStart}
            initialView={initialView}
            headerToolbar={false}
            height={view.startsWith("timeGrid") ? "calc(100vh - 14rem)" : "auto"}
            scrollTime="07:00:00"
            nowIndicator
            dayMaxEvents={4}
            fixedWeekCount={false}
            eventSources={eventSources}
            loading={onLoading}
            datesSet={onDatesSet}
            editable
            droppable={hasTray}
            selectable={!!target}
            selectMirror
            eventAllow={stable.eventAllow}
            eventDrop={stable.eventDrop}
            eventResize={stable.eventResize}
            drop={stable.drop}
            eventDragStart={stable.eventDragStart}
            eventDragStop={stable.eventDragStop}
            select={stable.select}
            eventClick={stable.eventClick}
          />
        </div>
      </div>

      {showTray && (
        <Tray
          trayRef={trayRef}
          data={tray}
          active={overTray}
          titleFields={titleFields}
          canDrag={canMoveMain}
          onOpen={(row) => open(entity, row.name)}
          onMore={() => loadTray((tray?.page || 1) + 1)}
        />
      )}

      {opened && <EntryModal initialPath={opened} onClose={closeModal} onSaved={closeModal} />}
    </div>
  );
}
