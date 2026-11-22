import { useCallback, useEffect, useMemo, useState } from "react";
import loopar, { useRealtime } from "loopar";
import { Loader2, MapPinOffIcon, NavigationIcon, XIcon } from "lucide-react";
import { Link } from "@link";
import { Button } from "@cn/components/ui/button";
import { cn } from "@cn/lib/utils";
import { EntryModal } from "@app/entry-modal";
import { useWorkspace } from "@workspace/workspace-provider";
import { useViewOptions } from "@loopar/document";
import { canOn } from "@context/auth-context";
import { useTable } from "@@table/TableContext";
import { TableSearch } from "@@table/TableSearch";
import { ListFilters } from "@@table/ListFilters";
import { recordLink } from "@@table/record-link";
import { queryOf } from "@@table/list-url";
import { MapView } from "@@maps";
import { STATE_COLORS } from "../form/workflow-bar";
import { REPORT_PARAMS } from "@global/list-report";
import { addressText, coordinatesOf } from "@global/geo";
import { formatNumber } from "@global/format";
import { __ } from "@global/i18n";
import { geoOf } from "./views";

/**
 * Map view for entities with a place (global/geo.js): the list's records
 * where they are, with the list's search and filters (`{Entity}/map`).
 * Places that overlap are grouped until the map is close enough to tell
 * them apart. Clicking one shows what it is; from there the record opens in
 * a modal, without leaving the map. Records without coordinates are counted,
 * not drawn.
 */

const WORLD = { latitude: 20, longitude: 0 };
const blank = (value) => value === null || value === undefined || value === "";
const directionsUrl = (point) => `https://www.google.com/maps/dir/?api=1&destination=${point.latitude},${point.longitude}`;

export function MapListView({ ctrl }) {
  const Document = ctrl.Document;
  const Entity = Document.Entity;
  const entity = Entity?.name;
  const geo = geoOf(Document);
  const { pathname: currentUrl, workspace } = useWorkspace();
  const { search } = useTable();
  const { hasSearchForm = true } = useViewOptions();
  const portal = workspace === "portal";

  const [state, setState] = useState({ loading: true, data: null, issue: null });
  const [tick, setTick] = useState(0);
  const [selected, setSelected] = useState(null);
  const [opened, setOpened] = useState(null);

  // The list's filters live in the URL: the map applies the same ones.
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
    loopar.call(entity, "map", { query: Object.fromEntries(new URLSearchParams(filters)), freeze: false })
      .then((data) => alive && setState({ loading: false, data, issue: null }))
      .catch((e) => alive && setState({ loading: false, data: null, issue: e?.message || String(e) }));
    return () => { alive = false; };
  }, [entity, filters, tick]);

  const data = state.data;
  const places = useMemo(() => {
    if (!data) return { points: [], byName: {} };
    const byName = {};
    const points = [];
    for (const row of data.rows || []) {
      const at = coordinatesOf(row[data.latitude], row[data.longitude]);
      if (!at) continue;
      byName[row.name] = row;
      points.push({ id: row.name, ...at });
    }
    return { points, byName };
  }, [data]);

  const row = selected ? places.byName[selected] : null;
  useEffect(() => { if (selected && !row) setSelected(null); }, [selected, row]);

  if (!geo) return null;

  const titleOf = (r) => (data?.titleFields || []).map((f) => r.__titles__?.[f] ?? r[f]).filter((v) => !blank(v)).join(" ") || r.name;
  const closeModal = () => { setOpened(null); reload(); };
  const open = (r) => setOpened(`/desk/${entity}/update?name=${encodeURIComponent(r.name)}`);
  const editable = (r) => !portal && !Entity.read_only && canOn(entity, "update", r);
  const stateOf = (r) => (data?.state ? r[data.state.field] : null);
  const unplaced = data?.unplaced || 0;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">{hasSearchForm && <TableSearch onChange={search} />}</div>
        <ListFilters />
      </div>

      {data?.truncated && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
          {__("This map has more records than it can show ({0}). Add filters to see the rest.", [formatNumber(places.points.length)])}
        </div>
      )}

      {state.issue ? (
        <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">{state.issue}</div>
      ) : (
        <div className={cn("relative h-[65vh] min-h-96 w-full overflow-hidden rounded-xl border", state.loading && data && "opacity-80")}>
          {!data ? (
            <div className="flex h-full items-center justify-center bg-muted/40"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>
          ) : (
            <MapView center={WORLD} zoom={1} points={places.points} selected={selected} onSelect={setSelected} />
          )}

          {data && places.points.length === 0 && (
            <div className="pointer-events-none absolute inset-x-0 top-4 flex justify-center">
              <div className="flex items-center gap-2 rounded-full border bg-popover px-4 py-2 text-sm text-muted-foreground shadow">
                <MapPinOffIcon className="size-4" />
                {unplaced ? __("None of these records has a place on the map yet.") : __("No records match these filters.")}
              </div>
            </div>
          )}

          {row && (
            <div className="absolute inset-x-3 bottom-8 mx-auto flex max-w-md items-start gap-3 rounded-xl border bg-popover p-3 text-popover-foreground shadow-lg">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">{titleOf(row)}</p>
                {titleOf(row) !== row.name && <p className="truncate text-xs text-muted-foreground">{row.name}</p>}
                {addressText(row, data.address) && <p className="mt-1 text-xs text-muted-foreground">{addressText(row, data.address)}</p>}
                {!blank(stateOf(row)) && (
                  <span className={cn("mt-2 inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium",
                    STATE_COLORS[data.state.colors[stateOf(row)]] || STATE_COLORS.gray)}>
                    <span className="size-1.5 rounded-full bg-current" />{stateOf(row)}
                  </span>
                )}
                <div className="mt-2 flex items-center gap-3">
                  {editable(row) ? (
                    <Button type="button" size="sm" onClick={() => open(row)}>{__("Open")}</Button>
                  ) : (
                    <Link to={recordLink(Entity, row.name, row, { portal })} renderOnRestrict={true} className="text-sm text-primary hover:underline">{__("Open")}</Link>
                  )}
                  <a className="inline-flex items-center gap-1 text-xs text-primary hover:underline" href={directionsUrl(coordinatesOf(row[data.latitude], row[data.longitude]))} target="_blank" rel="noopener noreferrer">
                    <NavigationIcon className="size-3.5" />{__("Directions")}
                  </a>
                </div>
              </div>
              <Button type="button" variant="ghost" className="size-7 shrink-0 p-0" onClick={() => setSelected(null)} aria-label={__("Close")}>
                <XIcon />
              </Button>
            </div>
          )}
        </div>
      )}

      {data && (
        <p className="text-xs text-muted-foreground">
          {__("{0} on the map", [formatNumber(places.points.length)])}
          {unplaced > 0 && ` · ${__("{0} without a place", [formatNumber(unplaced)])}`}
        </p>
      )}

      {opened && <EntryModal initialPath={opened} onClose={closeModal} onSaved={closeModal} />}
    </div>
  );
}
