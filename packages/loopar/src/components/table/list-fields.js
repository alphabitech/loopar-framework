import { isListableField } from "@global/list-settings";
import { filterKind, SYSTEM_DATE_FIELDS } from "@global/list-filters";
import { resolveColumnFormat } from "@global/element-definition";
import { DEFAULT_GRAIN } from "@global/list-report";

/** Every element of a structure (string or array), containers and their children alike. */
export function flatElements(structure) {
  let nodes = structure;
  if (typeof nodes === "string") {
    try { nodes = JSON.parse(nodes); } catch { nodes = []; }
  }
  const walk = (elements) => (Array.isArray(elements) ? elements : []).flatMap((el) => [el, ...walk(el?.elements)]);
  return walk(nodes);
}

/**
 * Fields of a list that filters and reports work with: the entity's plain,
 * readable fields (`elements`: its structure, flat) and, when the table keeps
 * them (`recordDates`), the record dates.
 *
 * → [{ name, label, element, kind, format, data }]   kind: global/list-filters.js
 */
export function listFields(elements = [], { recordDates = false } = {}) {
  const out = [];
  const seen = new Set();
  for (const el of elements) {
    const name = el?.data?.name;
    if (!name || seen.has(name) || !isListableField(el)) continue;
    seen.add(name);
    out.push({ name, label: el.data.label || name, element: el.element, kind: filterKind(el), format: resolveColumnFormat(el), data: el.data });
  }
  if (recordDates) {
    for (const [name, label] of Object.entries(SYSTEM_DATE_FIELDS)) {
      out.push({ name, label, element: "date_time", kind: "datetime", format: null, data: { name, label } });
    }
  }
  return out;
}

export const isDateKind = (kind) => kind === "date" || kind === "datetime";

/** Fields a report can group by: choices, dates, switches and short text. */
export const groupableFields = (fields) => fields.filter((f) =>
  ["choice", "bool", "date", "datetime"].includes(f.kind) || (f.kind === "text" && f.element === "input"));

/** Numbers a report can add up (not percentages, ratings or sliders). */
export const summableFields = (fields) => fields.filter((f) =>
  f.kind === "number" && !["range", "rating"].includes(f.element) && f.format !== "percent");

/**
 * The report a list opens with: grouped by its workflow state, else by its
 * first choice in the list, else by month of its first date; summing its
 * first amount.
 */
export function defaultReportSpec(fields, { workflowField = null } = {}) {
  const groupable = groupableFields(fields);
  const inList = (f) => [1, "1", true, "true"].includes(f.data?.in_list_view);
  const choices = groupable.filter((f) => f.kind === "choice");
  const dates = groupable.filter((f) => isDateKind(f.kind));

  const group = groupable.find((f) => f.name === workflowField)
    || choices.find(inList) || choices[0]
    || dates.find(inList) || dates[0]
    || null;

  const amount = summableFields(fields).find((f) => f.format === "currency");
  return {
    groups: group ? [{ field: group.name, grain: isDateKind(group.kind) ? DEFAULT_GRAIN : null }] : [],
    values: amount ? [{ fn: "sum", field: amount.name }] : [],
    chart: "bar",
  };
}
