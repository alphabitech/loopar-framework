'use strict';

/**
 * A user's settings for the list of one entity — shared by the server (which
 * stores them and applies sort and extra columns) and the client (which
 * applies order, visibility and widths):
 *
 *   { order:  ["tenant_name", "status"],   // column order, first to last
 *     hidden: ["plan"],                     // list columns the user hid
 *     shown:  ["notes"],                    // extra columns the user added
 *     widths: { tenant_name: 240 },         // px
 *     sort:   [{ field: "plan", dir: "asc" }, { field: "status", dir: "desc" }] }
 *
 * Without settings a list shows the fields marked `in_list_view`, in the
 * order of `list_order` and then of the form.
 */
export const LIST_SETTING_ENTITY = "List View Setting";

/** Key of the title column (the entity's `title_fields`) in `widths`. */
export const TITLE_COLUMN = "__title__";

export const MAX_SORT_FIELDS = 5;
const MAX_COLUMNS = 200;
const MIN_WIDTH = 60;
const MAX_WIDTH = 1200;

const FIELD_NAME = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;
const truthy = (value) => [1, "1", true, "true"].includes(value);

// Elements whose value reads well in a list cell.
const LISTABLE_ELEMENTS = new Set([
  "input", "textarea", "select", "connection", "radio_group", "switch", "checkbox",
  "date", "date_time", "time", "color_picker", "icon_input", "range", "rating", "id",
]);

/**
 * Whether a user may add the field to a list as an extra column: a plain
 * value, not hidden, not a secret. (Fields marked `in_list_view` are the
 * developer's choice and don't go through this.)
 */
export function isListableField(field) {
  const data = field?.data || {};
  if (!FIELD_NAME.test(String(data.name || ""))) return false;
  if (!LISTABLE_ELEMENTS.has(field.element)) return false;
  if (truthy(data.hidden)) return false;
  if (data.write_policy === "system") return false;
  if ([data.type, data.format].some((v) => String(v || "").toLowerCase() === "password")) return false;
  return true;
}

/** `"plan,-status"` → `[{ field: "plan", dir: "asc" }, { field: "status", dir: "desc" }]`. */
export function parseSort(text) {
  const seen = new Set();
  const out = [];
  for (const raw of String(text ?? "").split(",")) {
    const part = raw.trim();
    const field = part.replace(/^[-+]/, "");
    if (!FIELD_NAME.test(field) || seen.has(field)) continue;
    seen.add(field);
    out.push({ field, dir: part.startsWith("-") ? "desc" : "asc" });
    if (out.length === MAX_SORT_FIELDS) break;
  }
  return out;
}

/** The inverse of parseSort: the value of the list's `?sort=` parameter. */
export function formatSort(sort = []) {
  return (sort || []).map((s) => (s.dir === "desc" ? "-" : "") + s.field).join(",");
}

const names = (list, extra = []) => {
  const out = [];
  for (const value of Array.isArray(list) ? list : []) {
    const name = String(value ?? "");
    if ((FIELD_NAME.test(name) || extra.includes(name)) && !out.includes(name)) out.push(name);
    if (out.length === MAX_COLUMNS) break;
  }
  return out;
};

/** Settings as stored and used: unknown keys dropped, every value checked. */
export function normalizeListSettings(raw) {
  let source = raw;
  if (typeof source === "string") {
    try { source = JSON.parse(source); } catch { source = null; }
  }
  if (!source || typeof source !== "object" || Array.isArray(source)) source = {};

  const widths = {};
  const rawWidths = source.widths && typeof source.widths === "object" ? source.widths : {};
  for (const [name, value] of Object.entries(rawWidths).slice(0, MAX_COLUMNS)) {
    const width = Math.round(Number(value));
    if ((FIELD_NAME.test(name) || name === TITLE_COLUMN) && Number.isFinite(width)) {
      widths[name] = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width));
    }
  }

  const sort = Array.isArray(source.sort)
    ? parseSort(formatSort(source.sort.filter((s) => s && typeof s.field === "string")))
    : [];

  return {
    order: names(source.order),
    hidden: names(source.hidden),
    shown: names(source.shown),
    widths,
    sort,
  };
}

/** Name of the record that keeps `user`'s settings for the list of `entity`. */
export const listSettingName = (user, entity) => `${user}::${entity}`;

const defaultPosition = (field) => {
  const n = parseInt(field.data?.list_order, 10);
  return Number.isFinite(n) && n > 0 ? n : Infinity;
};

/**
 * Columns of a list for a user, in display order. `fields`: the entity's
 * elements, flat. Base: the fields marked `in_list_view`, plus the user's
 * `shown`, minus their `hidden`. Order: the user's `order` first; the rest by
 * `list_order` (ascending) and then as they come in the form.
 */
export function resolveListColumns(fields = [], settings = null) {
  const { order = [], hidden = [], shown = [] } = settings || {};
  const seen = new Set();
  const rank = (name) => {
    const i = order.indexOf(name);
    return i === -1 ? Infinity : i;
  };
  // Infinity - Infinity is NaN (falsy): the next criterion decides.
  const by = (a, b) => (a - b) || 0;

  return fields
    .filter((field) => {
      const name = field?.data?.name;
      if (field?.isCustom || !name || seen.has(name) || hidden.includes(name)) return false;
      if (!truthy(field.data.in_list_view) && !(shown.includes(name) && isListableField(field))) return false;
      seen.add(name);
      return true;
    })
    .map((field, index) => ({ field, index }))
    .sort((a, b) =>
      by(rank(a.field.data.name), rank(b.field.data.name)) ||
      by(defaultPosition(a.field), defaultPosition(b.field)) ||
      (a.index - b.index))
    .map(({ field }) => field);
}

/**
 * Fields a user can turn on or off as list columns: `{ field, isDefault }`,
 * the list columns first (isDefault) and then every other listable field.
 */
export function listColumnChoices(fields = []) {
  const seen = new Set();
  const choices = [];
  for (const field of fields) {
    const name = field?.data?.name;
    if (field?.isCustom || !name || seen.has(name)) continue;
    const isDefault = truthy(field.data.in_list_view);
    if (!isDefault && !isListableField(field)) continue;
    seen.add(name);
    choices.push({ field, isDefault });
  }
  return [...choices.filter((c) => c.isDefault), ...choices.filter((c) => !c.isDefault)];
}
