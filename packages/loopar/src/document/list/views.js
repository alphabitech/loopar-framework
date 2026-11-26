import { calendarFields } from "@global/calendar";
import { treeFields } from "@global/tree";
import { geoFields } from "@global/geo";

// One entity's structure is asked for many times per render: keep the last answer.
let last = { structure: null, calendar: null };
let lastTree = { structure: null, tree: null };
let lastGeo = { structure: null, geo: null };

/** Calendar fields of a list Document (global/calendar.js convention), or null. */
export function calendarOf(Document) {
  const structure = Document?.Entity?.doc_structure || null;
  if (!structure) return null;
  if (last.structure !== structure) last = { structure, calendar: calendarFields(structure) };
  return last.calendar;
}

/**
 * List views available for a list Document, in toggle order. Tree needs a
 * parent field; Kanban needs an active workflow; Calendar needs a date
 * field; Map needs latitude and longitude fields. List, Grid, Tree, Kanban,
 * Calendar and Map are remembered per user; Report is in the URL (`?report=…`,
 * global/list-report.js), so a report can be shared.
 * `custom`: views a list declares itself (view option `customViews`:
 * `{ Name: { icon, label, render(ctrl) } }`), listed before Report.
 */
export const listViews = (Document, custom = null) => [
  "List",
  "Grid",
  ...(treeOf(Document) ? ["Tree"] : []),
  ...(Document?.workflow ? ["Kanban"] : []),
  ...(calendarOf(Document) ? ["Calendar"] : []),
  ...(geoOf(Document) ? ["Map"] : []),
  ...Object.keys(custom || {}),
  "Report",
];

/** Tree fields of a list Document (global/tree.js convention), or null. */
export function treeOf(Document) {
  const structure = Document?.Entity?.doc_structure || null;
  if (!structure) return null;
  if (lastTree.structure !== structure) lastTree = { structure, tree: treeFields(structure, Document.Entity.name) };
  return lastTree.tree;
}

/** Place fields of a list Document (global/geo.js convention), or null. */
export function geoOf(Document) {
  const structure = Document?.Entity?.doc_structure || null;
  if (!structure) return null;
  if (lastGeo.structure !== structure) lastGeo = { structure, geo: geoFields(structure) };
  return lastGeo.geo;
}

/** The view the toggle switches to from `current`. */
export const nextListView = (Document, current, custom = null) => {
  const views = listViews(Document, custom);
  return views[(views.indexOf(current) + 1) % views.length];
};
