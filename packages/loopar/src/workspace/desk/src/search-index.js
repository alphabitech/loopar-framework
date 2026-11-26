import { useEffect, useState } from "react";
import loopar from "loopar";
import Emitter from "@services/emitter/emitter";

/**
 * The desk's search index (every entity the user can open, see
 * WorkspaceController.deskSearchIndex), loaded once per page after it is
 * interactive instead of travelling inside every page's HTML. `null` until it
 * arrives: the server render and the first client render both see none.
 */
let cache = null;
let pending = null;
const listeners = new Set();

const publish = (items) => {
  cache = Array.isArray(items) ? items : [];
  listeners.forEach(listener => listener(cache));
};

const load = () => {
  pending ||= loopar.call("Desk Pin", "destinations", { freeze: false, notifyError: false })
    .then(res => publish(res?.search_index))
    .catch(() => { pending = null; });
  return pending;
};

const whenIdle = (fn) => (window.requestIdleCallback ? window.requestIdleCallback(fn, { timeout: 2000 }) : setTimeout(fn, 200));

// The desk menu changed (apps installed/removed): its payload carries the new index.
Emitter.on("workspace-meta", (meta) => {
  if (Array.isArray(meta?.search_index)) publish(meta.search_index);
});

export function useSearchIndex() {
  const [index, setIndex] = useState(null);

  useEffect(() => {
    listeners.add(setIndex);
    if (cache) setIndex(cache);
    else whenIdle(load);
    return () => { listeners.delete(setIndex); };
  }, []);

  return index;
}
