import { useCallback, useEffect, useState } from "react";
import loopar from "loopar";
import { Link } from "@link";
import { CalendarPlusIcon, Loader2, MapPinIcon } from "lucide-react";
import { award } from "@context/auth-context";
import { __ } from "@global/i18n";

/**
 * Calendar events of a record: any saved record of a business entity can be
 * scheduled ("Schedule" in its form's bar creates an Event related to it),
 * and its form lists the events it already has (`Event/of`).
 */

const EVENT = "Event";
const CHANGED = "loopar:record-events";
const OWN = new Set([EVENT, "Calendar"]);

/** `{ document, documentName, title }` when the open record can have events, else null. */
export function eventTarget(Document) {
  const Entity = Document?.Entity || {};
  const name = Document?.name || Document?.data?.name;
  if (Document?.meta?.action !== "update" || Document?.isNew || !name) return null;
  if (!Entity.name || OWN.has(Entity.name) || Entity.is_single || Entity.is_builder) return null;
  // Business records keep a history; settings, builders and system lists don't get events.
  if (!loopar.utils.trueValue(Entity.enable_history)) return null;

  const titleField = String(Entity.title_fields || "").split(",").map((f) => f.trim()).find(Boolean);
  const title = String((titleField && Document.data?.[titleField]) || name);
  return { document: Entity.name, documentName: String(name), title };
}

/** "Schedule" action of a record's form: a new Event related to it, in a modal. */
export function ScheduleAction({ Document }) {
  const target = eventTarget(Document);
  if (!target || !award(EVENT, "create")) return null;

  const params = new URLSearchParams({ document: target.document, document_name: target.documentName, title: target.title.slice(0, 200) });
  return (
    <Link
      to={`/desk/${EVENT}/create?${params.toString()}`}
      inModal
      variant="secondary"
      className="px-2"
      title={__("Schedule")}
      onSaved={() => window.dispatchEvent(new CustomEvent(CHANGED))}
    >
      <CalendarPlusIcon />
      <span className="lp-menu-label pl-1">{__("Schedule")}</span>
    </Link>
  );
}

const when = (event) => {
  const start = new Date(String(event.starts_at).replace(" ", "T"));
  if (isNaN(start.getTime())) return "";
  const day = { weekday: "short", year: "numeric", month: "short", day: "numeric" };
  if (event.all_day) return start.toLocaleDateString(loopar.language || undefined, day);
  return start.toLocaleString(loopar.language || undefined, { ...day, hour: "numeric", minute: "2-digit" });
};

/** The events of the open record, soonest first. Draws nothing while it has none. */
export function RecordEvents({ ctrl }) {
  const Document = ctrl.Document;
  const target = eventTarget(Document);
  const document = target?.document;
  const documentName = target?.documentName;
  const [state, setState] = useState({ loading: false, events: [] });
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    window.addEventListener(CHANGED, reload);
    return () => window.removeEventListener(CHANGED, reload);
  }, [reload]);

  useEffect(() => {
    if (!document || !documentName || !award(EVENT, "of")) return;
    let alive = true;
    loopar.call(EVENT, "of", {
      query: { document, document_name: documentName },
      freeze: false,
      notifyError: false,
      success: (r) => alive && setState({ loading: false, events: Array.isArray(r?.events) ? r.events : [] }),
      error: () => alive && setState({ loading: false, events: [] }),
    });
    return () => { alive = false; };
  }, [document, documentName, version]);

  if (!target || state.events.length === 0) return null;

  return (
    <div className="mb-4 w-full rounded-xl border bg-card">
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <span className="font-semibold">{__("Events")}</span>
        <span className="text-xs text-muted-foreground">{state.events.length}</span>
        {state.loading && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
      </div>
      <ul className="divide-y">
        {state.events.map((event) => (
          <li key={event.name} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
            <Link
              to={`/desk/${EVENT}/update?name=${encodeURIComponent(event.name)}`}
              inModal
              bare
              onSaved={reload}
              className="font-medium text-foreground hover:underline"
            >
              {event.title}
            </Link>
            <span className="text-muted-foreground">{when(event)}</span>
            {event.location && (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <MapPinIcon className="size-3.5" /> {event.location}
              </span>
            )}
            {event.calendar && <span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{event.calendar}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
