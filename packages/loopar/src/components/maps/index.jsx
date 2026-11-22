import { lazy, Suspense, useEffect, useState } from "react";
import loopar from "loopar";
import { Loader2 } from "lucide-react";

const MapCanvas = lazy(() => import("./map-canvas"));

/** The site's map settings (`Maps/config`), asked once per page load. */
let pending = null;
const FALLBACK = { style: "https://tiles.openfreemap.org/styles/liberty", style_dark: "https://tiles.openfreemap.org/styles/dark", geocoder: false };

export function useMapsConfig() {
  const [config, setConfig] = useState(null);
  useEffect(() => {
    let alive = true;
    pending ??= loopar.call("Maps", "config", { freeze: false, notifyError: false })
      .then((r) => r?.maps || FALLBACK)
      .catch(() => FALLBACK);
    pending.then((maps) => alive && setConfig(maps));
    return () => { alive = false; };
  }, []);
  return config;
}

/** Whether the dark theme is on (the `dark` class of the page), followed live. */
function useDarkTheme() {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const root = document.documentElement;
    const read = () => setDark(root.classList.contains("dark"));
    read();
    const observer = new MutationObserver(read);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return dark;
}

const Waiting = () => (
  <div className="flex h-full w-full items-center justify-center bg-muted/40">
    <Loader2 className="size-5 animate-spin text-muted-foreground" />
  </div>
);

/**
 * A map with the site's style, in the current theme. Browser only: the
 * server and the first paint show the waiting state, so hydration matches.
 * Props: those of `map-canvas.jsx` but `style`.
 */
export function MapView(props) {
  const config = useMapsConfig();
  const dark = useDarkTheme();
  if (!config) return <Waiting />;
  return (
    <Suspense fallback={<Waiting />}>
      <MapCanvas {...props} style={dark ? config.style_dark : config.style} />
    </Suspense>
  );
}
