import { useEffect, useState } from "react";
import loopar from "loopar";
import { useDocument } from "@loopar/document";
import { useDesigner } from "@context/designer-context";
import { formatCurrency, formatNumber as formatRegionalNumber } from "@global/format";
import { currentLanguage } from "@global/i18n";

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
  if (format === "currency") return formatCurrency(n);
  return formatRegionalNumber(n, { maximumFractionDigits: 2 });
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

const UNITS = [
  ["year", 365 * 24 * 3600], ["month", 30 * 24 * 3600], ["week", 7 * 24 * 3600],
  ["day", 24 * 3600], ["hour", 3600], ["minute", 60],
];

/** "12 minutes ago", "yesterday"… in the desk language; "" for an unreadable date. */
export function timeAgo(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const seconds = (date.getTime() - Date.now()) / 1000;
  let rtf;
  try { rtf = new Intl.RelativeTimeFormat(currentLanguage() || undefined, { numeric: "auto" }); }
  catch { rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }); }
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
  }
  return rtf.format(0, "minute");
}

