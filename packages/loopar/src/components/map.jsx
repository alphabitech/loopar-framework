import { useContext, useMemo, useState } from "react";
import loopar from "loopar";
import { Loader2, LocateFixedIcon, MapPinIcon, MapPinOffIcon, NavigationIcon } from "lucide-react";
import { Button } from "@cn/components/ui/button";
import { cn } from "@cn/lib/utils";
import { useDesigner } from "@context/designer-context";
import { BaseFormContext } from "./form-context";
import { ComponentDefaults } from "./base/ComponentDefaults";
import { rootProps } from "./base/root-props.js";
import { MapView, useMapsConfig } from "./maps";
import { geoFields, addressText, coordinatesOf, roundCoordinate } from "@global/geo";
import { __ } from "@global/i18n";

/**
 * map — a place on a map (MapLibre GL, the site's style: integrations › Maps).
 *
 * On a page it shows the point its own data names (`latitude` / `longitude`;
 * the designer looks up `address` and lets the pin be dragged).
 *
 * In the form of an entity with a place (global/geo.js: fields `latitude`
 * and `longitude`) it shows the record's point and edits it: the pin can be
 * dragged, a click places it when there is none, and "Locate address" asks
 * the geocoder for the address typed in the form. Saving an address without
 * a point looks it up by itself (core-document).
 */

const DEFAULT_ZOOM = 14;
const DEFAULT_HEIGHT = 360;
// Somewhere to start from before there is a point: the whole world.
const WORLD = { latitude: 20, longitude: 0 };
const truthy = (v) => [true, "true", 1, "1"].includes(v);

const heightOf = (value) => {
  const text = String(value ?? "").trim();
  if (!text) return DEFAULT_HEIGHT;
  return /^\d+(\.\d+)?$/.test(text) ? Number(text) : text;
};

const directionsUrl = (point) => `https://www.google.com/maps/dir/?api=1&destination=${point.latitude},${point.longitude}`;

function Placeholder({ icon: Icon = MapPinIcon, children }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-muted/40 p-4 text-center text-sm text-muted-foreground">
      <Icon className="size-6" />
      <p className="max-w-sm">{children}</p>
    </div>
  );
}

export default function MapElement(props) {
  const data = props.data || {};
  const { designing, designerMode } = useDesigner();
  const inDesigner = !!(designing || designerMode);
  const { set } = ComponentDefaults(props);
  const config = useMapsConfig();
  const form = useContext(BaseFormContext);
  const [locating, setLocating] = useState(false);

  // In the form of an entity with a place, the map is the record's.
  const Entity = form?.docRef?.Document?.Entity;
  const geo = useMemo(
    () => (inDesigner || !Entity?.doc_structure ? null : geoFields(Entity.doc_structure)),
    [inDesigner, Entity?.doc_structure]
  );
  const values = form?.values || {};

  const zoom = Number(data.zoom) > 0 ? Number(data.zoom) : DEFAULT_ZOOM;
  const frame = (children, toolbar = null) => (
    <div {...rootProps(props)} className={cn("flex w-full flex-col gap-2", props.className)}>
      {toolbar}
      <div className="w-full overflow-hidden rounded-xl border" style={{ height: heightOf(data.height) }}>{children}</div>
    </div>
  );

  // ----- A record's place (form) -----
  if (geo) {
    const point = coordinatesOf(values[geo.latitude], values[geo.longitude]);
    const address = addressText(values, geo.address);
    const editable = geo.editable && !Entity.read_only;

    const place = (at) => {
      form.setValue(geo.latitude, at ? roundCoordinate(at.latitude) : "", { shouldDirty: true, shouldTouch: true });
      form.setValue(geo.longitude, at ? roundCoordinate(at.longitude) : "", { shouldDirty: true, shouldTouch: true });
    };

    const locate = () => {
      setLocating(true);
      loopar.call(Entity.name, "geocode", { body: { address }, freeze: false })
        .then((r) => (r?.place ? place(r.place) : loopar.notify(__("This address was not found. Place the pin by hand."), "warning")))
        .catch(() => {})
        .finally(() => setLocating(false));
    };

    const toolbar = editable && (
      <div className="flex flex-wrap items-center gap-2">
        {geo.address.length > 0 && config?.geocoder && (
          <Button type="button" variant="secondary" size="sm" onClick={locate} disabled={!address || locating}>
            {locating ? <Loader2 className="animate-spin" /> : <LocateFixedIcon />}
            {__("Locate address")}
          </Button>
        )}
        {point && (
          <Button type="button" variant="ghost" size="sm" onClick={() => place(null)}>
            <MapPinOffIcon />{__("Remove pin")}
          </Button>
        )}
        <span className="text-xs text-muted-foreground">
          {point ? __("Drag the pin to adjust it.") : __("Click the map to place the pin.")}
        </span>
        {point && (
          <a className="ml-auto inline-flex items-center gap-1 text-xs text-primary hover:underline" href={directionsUrl(point)} target="_blank" rel="noopener noreferrer">
            <NavigationIcon className="size-3.5" />{__("Directions")}
          </a>
        )}
      </div>
    );

    if (!point && !editable) return frame(<Placeholder icon={MapPinOffIcon}>{__("This record has no place on the map yet.")}</Placeholder>);

    return frame(
      <MapView
        center={point || WORLD}
        zoom={point ? zoom : 1}
        markers={point ? [{ id: "record", ...point, label: address, draggable: editable }] : []}
        onMove={editable ? (id, at) => place(at) : undefined}
        onPick={editable && !point ? place : undefined}
      />,
      toolbar
    );
  }

  // ----- A fixed place (page) -----
  const point = coordinatesOf(data.latitude, data.longitude);
  const address = String(data.address || "").trim();

  if (inDesigner && form && !point && !address && !data.label) {
    // Dropped in an entity's form: it will draw each record's place.
    return frame(<Placeholder>{__("Map. In a form with latitude and longitude fields it shows and edits the record's place; on a page, set its address or coordinates.")}</Placeholder>);
  }

  const locate = () => {
    setLocating(true);
    loopar.call("Maps", "geocode", { body: { address }, freeze: false })
      .then((r) => (r?.place
        ? set({ latitude: roundCoordinate(r.place.latitude), longitude: roundCoordinate(r.place.longitude) })
        : loopar.notify(__("This address was not found. Set the latitude and longitude instead."), "warning")))
      .catch(() => {})
      .finally(() => setLocating(false));
  };

  const toolbar = inDesigner && address && config?.geocoder ? (
    <div className="flex items-center gap-2">
      <Button type="button" variant="secondary" size="sm" onClick={locate} disabled={locating}>
        {locating ? <Loader2 className="animate-spin" /> : <LocateFixedIcon />}
        {__("Locate address")}
      </Button>
    </div>
  ) : null;

  if (!point) {
    return frame(
      <Placeholder icon={MapPinOffIcon}>
        {inDesigner ? __("Set the latitude and longitude of the place (or its address and \"Locate address\").") : (address || __("Map"))}
      </Placeholder>,
      toolbar
    );
  }

  return frame(
    <>
      <MapView
        center={point}
        zoom={zoom}
        cooperative={!inDesigner}
        markers={[{ id: "place", ...point, label: data.label || address, draggable: inDesigner }]}
        onMove={inDesigner ? (id, at) => set({ latitude: roundCoordinate(at.latitude), longitude: roundCoordinate(at.longitude) }) : undefined}
      />
    </>,
    <>
      {toolbar}
      {!inDesigner && !truthy(data.hide_directions) && (
        <div className="order-last flex items-center justify-between gap-3 text-sm">
          <span className="min-w-0 truncate text-muted-foreground">{address || data.label}</span>
          <a className="inline-flex shrink-0 items-center gap-1 text-primary hover:underline" href={directionsUrl(point)} target="_blank" rel="noopener noreferrer">
            <NavigationIcon className="size-4" />{__("Directions")}
          </a>
        </div>
      )}
    </>
  );
}

MapElement.metaFields = () => [[
  {
    group: "custom",
    elements: {
      address: {
        element: INPUT,
        data: { label: "Address", description: "Shown under the map. In the designer, \"Locate address\" turns it into the point (when a geocoder is set in Integrations › Maps)." },
      },
      latitude: { element: INPUT, data: { label: "Latitude", description: "Decimal degrees, e.g. 42.3601. Dragging the pin in the designer sets it." } },
      longitude: { element: INPUT, data: { label: "Longitude", description: "Decimal degrees, e.g. -71.0589." } },
      label: { element: INPUT, data: { label: "Pin label", description: "Shown when the pin is clicked. Empty: the address." } },
      zoom: {
        element: SELECT,
        data: {
          label: "Zoom",
          options: [
            { option: "Region", value: "9" },
            { option: "City", value: "12" },
            { option: "Neighborhood", value: "14" },
            { option: "Street", value: "16" },
            { option: "Building", value: "18" },
          ],
          default: "14",
        },
      },
      height: { element: INPUT, data: { label: "Height", description: "Pixels (360) or any CSS size (50vh). Default 360." } },
      hide_directions: { element: SWITCH, data: { label: "Hide directions link" } },
    },
  },
]];
