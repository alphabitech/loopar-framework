import { useEffect, useRef } from "react";
import { useDocument } from "./provider";
import { useViewOptionsPatch } from "./view-options";

/**
 * Runtime extensions from inside a view (they patch the view options).
 * Inline objects/functions are safe: the live value lives in a ref and the
 * registration depends only on the KEYS — never re-registers, never loops.
 * Static extensions belong in layout props or `export const config`.
 */

const SEP = "|";

/** Latest value in a ref + a stable string of its keys. */
function useLiveMap(map) {
  const ref = useRef(map);
  ref.current = map || {};
  const keys = Object.keys(map || {}).sort().join(SEP);
  return [ref, keys ? keys.split(SEP) : []];
}

/** Removes `names` from `options[group]`. */
const without = (group, names) => (prev) => {
  const next = { ...(prev[group] || {}) };
  for (const key of names) delete next[key];
  return { ...prev, [group]: next };
};

/** AppBar actions (`{ name: descriptor }`, see chrome/toolbar.jsx) while the caller is mounted. */
export function useActions(actions) {
  const patch = useViewOptionsPatch();
  const [ref, names] = useLiveMap(actions);
  const key = names.join(SEP);

  useEffect(() => {
    if (!names.length) return;
    // Read at render time: the AppBar resolves functions, so closures stay fresh.
    const live = Object.fromEntries(names.map((name) => [name, () => {
      const a = ref.current[name];
      return typeof a === "function" ? a() : a;
    }]));
    patch({ actions: live });
    return () => patch(without("actions", names));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patch, key]);
}

/** Named handlers callable from JSON buttons (`data.action`). */
export function useHandlers(handlers) {
  const patch = useViewOptionsPatch();
  const [ref, names] = useLiveMap(handlers);
  const key = names.join(SEP);

  useEffect(() => {
    if (!names.length) return;
    const live = Object.fromEntries(names.map((name) => [name, (...args) => ref.current[name]?.(...args)]));
    patch({ handlers: live });
    return () => patch(without("handlers", names));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patch, key]);
}

/** Runtime override of view flags (`hasSidebar`, `canUpdate`, ...). */
export function useDocumentConfig(flags) {
  const patch = useViewOptionsPatch();
  const serialized = JSON.stringify(flags || {});

  useEffect(() => {
    const value = JSON.parse(serialized);
    const names = Object.keys(value);
    if (!names.length) return;
    patch(value);
    return () => patch((prev) => {
      const next = { ...prev };
      for (const name of names) delete next[name];
      return next;
    });
  }, [patch, serialized]);
}

/** Field event (`change`, `changed`...): `handler(event, ctrl)`. */
export function useFieldEvent(field, event, handler) {
  const { ctrl } = useDocument();
  const ref = useRef(handler);
  ref.current = handler;

  useEffect(() => {
    if (!ctrl || !field || !event) return;
    ctrl.fields.on(field, event, (e) => ref.current?.(e, ctrl));
    return () => ctrl.fields.off(field, event);
  }, [ctrl, field, event]);
}
