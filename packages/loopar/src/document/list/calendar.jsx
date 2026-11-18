import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import loopar from "loopar";
import { Loader2 } from "lucide-react";
import { useWorkspace } from "@workspace/workspace-provider";
import { award } from "@context/auth-context";
import { calendarOf } from "./views";
import { REPORT_PARAMS } from "@global/list-report";

/**
 * Calendar view of a list: the entity's records by date (global/calendar.js
 * convention). The list of Events is the site's calendar: it also draws,
 * as layers, every other entity with date fields the user may see
 * (`Event/layers`). The calendar itself (calendar-board.jsx) loads on demand,
 * in the browser only.
 */

const CalendarBoard = lazy(() => import("./calendar-board"));
const EVENT = "Event";

const Spinner = () => (
  <div className="flex justify-center py-16"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>
);

/** 0 (Sunday) … 6: first day of the week where the user is. */
function localeWeekStart() {
  try {
    const locale = new Intl.Locale(navigator.language);
    const info = typeof locale.getWeekInfo === "function" ? locale.getWeekInfo() : locale.weekInfo;
    return info?.firstDay ? info.firstDay % 7 : 0;
  } catch {
    return 0;
  }
}

export function CalendarView({ ctrl }) {
  const Document = ctrl.Document;
  const entity = Document.Entity?.name;
  const calendar = calendarOf(Document);
  const readOnly = !!Document.Entity?.read_only;

  const titleFields = useMemo(
    () => String(Document.Entity?.title_fields || "").split(",").map((s) => s.trim()).filter(Boolean),
    [Document.Entity?.title_fields]
  );

  // The list's own entity as a layer.
  const own = useMemo(() => (calendar ? {
    entity,
    ...calendar,
    editable: calendar.editable && !readOnly,
    creatable: !readOnly && award(entity, "create"),
  } : null), [entity, calendar, readOnly]);

  // Browser only: the week start comes from the user's locale and the library is client code.
  const [client, setClient] = useState(null);
  useEffect(() => { setClient({ weekStart: localeWeekStart() }); }, []);

  // The Event list draws every layer of the site.
  const [site, setSite] = useState(entity === EVENT ? null : { layers: [], calendars: [] });
  useEffect(() => {
    if (entity !== EVENT) return;
    let alive = true;
    loopar.call(EVENT, "layers", { freeze: false })
      .then((r) => alive && setSite({ layers: Array.isArray(r?.layers) ? r.layers : [], calendars: Array.isArray(r?.calendars) ? r.calendars : [] }))
      .catch(() => alive && setSite({ layers: [], calendars: [] }));
    return () => { alive = false; };
  }, [entity]);

  const layers = useMemo(() => {
    if (!own) return [];
    const others = (site?.layers || []).filter((l) => l.entity !== entity);
    return [own, ...others];
  }, [own, site, entity]);

  // The list's filters live in the URL: the calendar applies the same ones.
  const { pathname: currentUrl } = useWorkspace();
  const filters = useMemo(() => {
    const params = new URLSearchParams(String(currentUrl || "").split("?")[1] || "");
    ["page", "sort", ...REPORT_PARAMS].forEach((k) => params.delete(k));
    return params.toString();
  }, [currentUrl]);

  if (!own) return null;
  if (!client || !site) return <Spinner />;

  return (
    <Suspense fallback={<Spinner />}>
      <CalendarBoard
        entity={entity}
        layers={layers}
        calendars={site.calendars}
        filters={filters}
        titleFields={titleFields}
        weekStart={client.weekStart}
      />
    </Suspense>
  );
}
