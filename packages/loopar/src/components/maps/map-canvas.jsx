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

export default function MapCanvas({ style, center, zoom = 14, markers = [], onMove, onPick, cooperative = false, className }) {
  const container = useRef(null);
  const map = useRef(null);
  const drawn = useRef([]);
  const styleRef = useRef(style);
  // The map lives across renders: it always calls the latest handlers.
  const handlers = useRef({ onMove, onPick });
  handlers.current = { onMove, onPick };

  useEffect(() => {
    const instance = new MapLibreMap({
      container: container.current,
      style,
      center: [center.longitude, center.latitude],
      zoom,
      cooperativeGestures: cooperative,
      attributionControl: { compact: true },
    });
    instance.addControl(new NavigationControl({ showCompass: false }), "top-right");
    instance.on("click", (e) => handlers.current.onPick?.({ latitude: e.lngLat.lat, longitude: e.lngLat.lng }));
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
    map.current?.easeTo({ center: [center.longitude, center.latitude], zoom, duration: 400 });
  }, [center.latitude, center.longitude, zoom]);

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
