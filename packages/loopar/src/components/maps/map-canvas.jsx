import { useEffect, useRef } from "react";
import { MapLibreMap, Marker, NavigationControl, Popup, setWorkerUrl } from "maplibre-gl";
// MapLibre looks for its worker next to its own file, which a bundler moves:
// the bundler builds the worker and says where it ended up.
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "maplibre-gl/dist/maplibre-gl.css";
import "./map-canvas.css";
import { cn } from "@cn/lib/utils";

/**
 * The map itself (MapLibre GL): one style, a view and its markers. Loaded
 * on demand (`./index.jsx`) so the library only reaches pages that draw a
 * map.
 *
 *   markers   [{ id, latitude, longitude, label, draggable }]
 *   onMove    (id, { latitude, longitude })   a draggable marker was dropped
 *   onPick    ({ latitude, longitude })       the map was clicked
 *   points    [{ id, latitude, longitude }]   many places: drawn by the map
 *             itself and grouped while they overlap (a list seen as a map)
 *   selected  id of the point to highlight
 *   onSelect  (id | null)                     a point (or nothing) was clicked
 *
 * With `points` the view frames them all whenever the set changes.
 *
 * `cooperative`: on a page the map only zooms with ctrl/⌘ + wheel (or two
 * fingers), so scrolling the page never gets caught in it.
 */

setWorkerUrl(workerUrl);

/** The theme's primary color as MapLibre takes it (the tokens are bare HSL parts). */
function primaryColor() {
  const parts = getComputedStyle(document.documentElement).getPropertyValue("--primary").trim();
  return parts ? `hsl(${parts.replace(/\s+/g, ", ")})` : "#e8590c";
}

/**
 * OpenFreeMap's `dark` is drawn almost black on black: streets and names
 * barely show. The default dark map lifts them, so it stays dark but reads.
 * Only that style is touched: a style the site sets is drawn as it comes.
 */
const DEFAULT_DARK = "https://tiles.openfreemap.org/styles/dark";
const LABEL_HALO = "rgba(12, 13, 15, 0.9)";
const DARK_PAINT = {
  background: { "background-color": "#16171a" },
  water: { "fill-color": "#0d1b29" },
  waterway: { "line-color": "#0d1b29" },
  landuse_residential: { "fill-color": "#1a1b1e" },
  landuse_park: { "fill-color": "#16221b" },
  landcover_wood: { "fill-color": "#16221b" },
  building: { "fill-color": "#202226", "fill-outline-color": "#2b2d32" },
  "aeroway-area": { "fill-color": "#1c1d21" },
  "aeroway-taxiway": { "line-color": "#30323a" },
  "aeroway-runway-casing": { "line-color": "#25272c" },
  "aeroway-runway": { "line-color": "#383b43" },
  road_area_pier: { "fill-color": "#16171a" },
  road_pier: { "line-color": "#16171a" },
  highway_path: { "line-color": "#3d4048" },
  highway_minor: { "line-color": "#383b43" },
  highway_major_casing: { "line-color": "#24262b" },
  highway_major_inner: { "line-color": "#50545e" },
  highway_major_subtle: { "line-color": "#4a4e57" },
  highway_motorway_casing: { "line-color": "#24262b" },
  highway_motorway_inner: { "line-color": ["interpolate", ["linear"], ["zoom"], 5.8, "hsla(0,0%,85%,0.53)", 6, "#666b77"] },
  highway_motorway_subtle: { "line-color": "#5a5e69" },
  railway_transit: { "line-color": "#3a3c42" },
  railway_minor: { "line-color": "#3a3c42" },
  railway: { "line-color": "#3a3c42" },
  railway_transit_dashline: { "line-color": "#1d1e22" },
  railway_minor_dashline: { "line-color": "#1d1e22" },
  railway_dashline: { "line-color": "#1d1e22" },
  boundary_state: { "line-color": "#4b4e57" },
  "boundary_country_z0-4": { "line-color": "#5a5e69" },
  "boundary_country_z5-": { "line-color": "#5a5e69" },
  water_name: { "text-color": "#6f8fae", "text-halo-color": "#0d1b29" },
  highway_name_other: { "text-color": "#a9adb7", "text-halo-color": LABEL_HALO },
  highway_name_motorway: { "text-color": "#c3c7d0", "text-halo-color": LABEL_HALO, "text-halo-width": 1 },
};
const DARK_PLACE = { "text-color": "#d5d8df", "text-halo-color": LABEL_HALO };

function tuneDefaultDark(map) {
  for (const layer of map.getStyle().layers) {
    const paint = DARK_PAINT[layer.id] || (layer.id.startsWith("place_") ? DARK_PLACE : null);
    for (const [property, value] of Object.entries(paint || {})) map.setPaintProperty(layer.id, property, value);
  }
}

const POINTS = "lp-points";
const LAYERS = { clusters: "lp-clusters", counts: "lp-cluster-counts", points: "lp-point", selected: "lp-point-selected" };

const toGeoJSON = (points) => ({
  type: "FeatureCollection",
  features: points.map((p) => ({ type: "Feature", properties: { id: String(p.id) }, geometry: { type: "Point", coordinates: [p.longitude, p.latitude] } })),
});

/** The points as a clustered source with its layers (again after every style change, which drops them). */
function installPoints(map, points, selected) {
  if (map.getSource(POINTS)) return;
  const color = primaryColor();
  map.addSource(POINTS, { type: "geojson", data: toGeoJSON(points), cluster: true, clusterRadius: 44, clusterMaxZoom: 15 });
  map.addLayer({
    id: LAYERS.clusters, type: "circle", source: POINTS, filter: ["has", "point_count"],
    paint: {
      "circle-color": color, "circle-opacity": 0.85,
      "circle-radius": ["step", ["get", "point_count"], 15, 10, 19, 50, 24, 200, 30],
      "circle-stroke-width": 3, "circle-stroke-color": "#ffffff", "circle-stroke-opacity": 0.6,
    },
  });
  // Labels need a font the style ships: borrowed from one of its own labels.
  const font = map.getStyle().layers.find((l) => l.type === "symbol" && l.layout?.["text-font"])?.layout["text-font"];
  if (font) {
    map.addLayer({
      id: LAYERS.counts, type: "symbol", source: POINTS, filter: ["has", "point_count"],
      layout: { "text-field": ["get", "point_count_abbreviated"], "text-font": font, "text-size": 12, "text-allow-overlap": true },
      paint: { "text-color": "#ffffff" },
    });
  }
  map.addLayer({
    id: LAYERS.points, type: "circle", source: POINTS, filter: ["!", ["has", "point_count"]],
    paint: { "circle-color": color, "circle-radius": 7, "circle-stroke-width": 2, "circle-stroke-color": "#ffffff" },
  });
  map.addLayer({
    id: LAYERS.selected, type: "circle", source: POINTS, filter: ["==", ["get", "id"], String(selected ?? "")],
    paint: { "circle-color": "#ffffff", "circle-radius": 10, "circle-stroke-width": 4, "circle-stroke-color": color },
  });
}

/** Frames every point (one point: its street). */
function frame(map, points) {
  if (!points.length) return;
  if (points.length === 1) return map.easeTo({ center: [points[0].longitude, points[0].latitude], zoom: 14, duration: 400 });
  let west = 180, east = -180, south = 90, north = -90;
  for (const p of points) {
    west = Math.min(west, p.longitude); east = Math.max(east, p.longitude);
    south = Math.min(south, p.latitude); north = Math.max(north, p.latitude);
  }
  map.fitBounds([[west, south], [east, north]], { padding: 56, maxZoom: 15, duration: 400 });
}

export default function MapCanvas({ style, center, zoom = 14, markers = [], points = null, selected = null, onMove, onPick, onSelect, cooperative = false, className }) {
  const container = useRef(null);
  const map = useRef(null);
  const drawn = useRef([]);
  const styleRef = useRef(style);
  // The map lives across renders: it always calls the latest handlers.
  const handlers = useRef({ onMove, onPick, onSelect });
  handlers.current = { onMove, onPick, onSelect };
  const live = useRef({ points, selected });
  live.current = { points, selected };

  useEffect(() => {
    const instance = new MapLibreMap({
      container: container.current,
      style,
      center: [center.longitude, center.latitude],
      zoom,
      cooperativeGestures: cooperative,
      // Always readable (the data's license asks for it), as one quiet line.
      attributionControl: { compact: false },
    });
    instance.addControl(new NavigationControl({ showCompass: false }), "top-right");
    const hit = (point) => (instance.getLayer(LAYERS.points)
      ? instance.queryRenderedFeatures(point, { layers: [LAYERS.clusters, LAYERS.points, LAYERS.selected] })[0]
      : null);

    instance.on("click", (e) => {
      const feature = hit(e.point);
      if (feature?.properties?.cluster) {
        // A group opens into its places.
        instance.getSource(POINTS).getClusterExpansionZoom(feature.properties.cluster_id)
          .then((next) => instance.easeTo({ center: feature.geometry.coordinates, zoom: next, duration: 400 }))
          .catch(() => {});
        return;
      }
      if (feature) return handlers.current.onSelect?.(feature.properties.id);
      if (live.current.points) handlers.current.onSelect?.(null);
      handlers.current.onPick?.({ latitude: e.lngLat.lat, longitude: e.lngLat.lng });
    });
    instance.on("mousemove", (e) => {
      if (!live.current.points) return;
      instance.getCanvas().style.cursor = hit(e.point) ? "pointer" : "";
    });
    // Sources and layers live in the style: put back whenever one loads.
    instance.on("style.load", () => {
      if (styleRef.current === DEFAULT_DARK) tuneDefaultDark(instance);
      if (live.current.points) installPoints(instance, live.current.points, live.current.selected);
    });
    instance.once("load", () => live.current.points && frame(instance, live.current.points));
    map.current = instance;

    // The container may get its size after mounting (tabs, modals).
    const observer = new ResizeObserver(() => instance.resize());
    observer.observe(container.current);

    return () => {
      observer.disconnect();
      drawn.current = [];
      map.current = null;
      instance.remove();
    };
  }, []);

  useEffect(() => {
    if (!map.current || styleRef.current === style) return;
    styleRef.current = style;
    map.current.setStyle(style);
  }, [style]);

  useEffect(() => {
    if (points) return; // framed by its points
    map.current?.easeTo({ center: [center.longitude, center.latitude], zoom, duration: 400 });
  }, [center.latitude, center.longitude, zoom]);

  const pointsKey = points ? JSON.stringify(points.map((p) => [p.id, p.latitude, p.longitude])) : null;
  useEffect(() => {
    const instance = map.current;
    if (!instance || !points || !instance.isStyleLoaded()) return;
    const source = instance.getSource(POINTS);
    if (source) source.setData(toGeoJSON(points));
    else installPoints(instance, points, selected);
    frame(instance, points);
  }, [pointsKey]);

  useEffect(() => {
    const instance = map.current;
    if (instance?.getLayer(LAYERS.selected)) instance.setFilter(LAYERS.selected, ["==", ["get", "id"], String(selected ?? "")]);
  }, [selected]);

  const signature = JSON.stringify(markers.map((m) => [m.id, m.latitude, m.longitude, m.label, !!m.draggable]));
  useEffect(() => {
    if (!map.current) return;
    drawn.current.forEach((marker) => marker.remove());
    const color = primaryColor();
    drawn.current = markers.map((m) => {
      const marker = new Marker({ color, draggable: !!m.draggable }).setLngLat([m.longitude, m.latitude]);
      if (m.label) marker.setPopup(new Popup({ offset: 28, closeButton: false }).setText(m.label));
      if (m.draggable) {
        marker.on("dragend", () => {
          const at = marker.getLngLat();
          handlers.current.onMove?.(m.id, { latitude: at.lat, longitude: at.lng });
        });
      }
      return marker.addTo(map.current);
    });
  }, [signature]);

  return <div ref={container} className={cn("lp-map h-full w-full", onPick && "lp-map-pick", className)} />;
}
