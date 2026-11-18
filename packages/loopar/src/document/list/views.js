import { calendarFields } from "@global/calendar";

// One entity's structure is asked for many times per render: keep the last answer.
let last = { structure: null, calendar: null };

/** Calendar fields of a list Document (global/calendar.js convention), or null. */
export function calendarOf(Document) {
  const structure = Document?.Entity?.doc_structure || null;
  if (!structure) return null;
  if (last.structure !== structure) last = { structure, calendar: calendarFields(structure) };
  return last.calendar;
}

/**
 * List views available for a list Document, in toggle order. Kanban needs an
 * active workflow; Calendar needs a date field. List, Grid, Kanban and
 * Calendar are remembered per user; Report is in the URL (`?report=…`,
 * global/list-report.js), so a report can be shared.
 */
export const listViews = (Document) => [
  "List",
  "Grid",
  ...(Document?.workflow ? ["Kanban"] : []),
  ...(calendarOf(Document) ? ["Calendar"] : []),
  "Report",
];

/** The view the toggle switches to from `current`. */
export const nextListView = (Document, current) => {
  const views = listViews(Document);
  return views[(views.indexOf(current) + 1) % views.length];
};
