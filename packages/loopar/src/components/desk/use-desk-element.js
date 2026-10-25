import { useEffect, useState } from "react";
import loopar from "loopar";
import { useDocument } from "@loopar/document";
import { useDesigner } from "@context/designer-context";

/**
 * Data of a desk page element, read by node key from the page's controller
 * (DeskPageController → core/document/desk-page.js). While designing there is
 * no page to ask: `designing` is true and the element paints a placeholder.
 *
 * → { designing, loading, data } — data: { value } | { rows, fields, entity }
 *   | { denied: true } | { issue }
 */
export function useDeskElement(node, enabled = true) {
  const { Document } = useDocument() || {};
  const { designerMode } = useDesigner();
  const page = Document?.Entity?.name;
  const active = enabled && !designerMode && !!page && !!node;

  const [state, setState] = useState({ loading: active, data: null });

  useEffect(() => {
    if (!active) return;
    let alive = true;
    setState(s => ({ ...s, loading: true }));

    loopar.call(page, "view", { query: { element: node }, freeze: false })
      .then(data => alive && setState({ loading: false, data: data || {} }))
      .catch(e => alive && setState({ loading: false, data: { issue: e?.message || "Could not load" } }));

    return () => { alive = false; };
  }, [active, page, node]);

  return { designing: !!designerMode, ...state };
}

export const deskLink = (target, action) => {
  if (!target) return "";
  if (target.startsWith("/") || target.startsWith("http")) return target;
  return `/desk/${target}/${action || "list"}`;
};

export const formatNumber = (value, format) => {
  const n = Number(value || 0);
  if (format === "currency") return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
};

/** Filter field of the element editor (a function: element globals load later). */
export const filterField = () => ({
  element: TEXTAREA,
  data: {
    label: "Filter",
    placeholder: '{"status": "Active"}',
    description: 'JSON of field: value (equality). Tokens: "@me" current user, "@today" today\'s date.',
  },
});
