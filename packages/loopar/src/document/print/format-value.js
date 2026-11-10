import { selectSource } from "@global/element-definition";
import { resolveColumnFormat } from "@global/element-definition";
import { __ } from "@global/i18n";
import { regional, formatNumber, formatCurrency, formatDate, formatDateTime } from "@global/format";

/**
 * Value → printable text, by element and column format. Pure (no React), so
 * the automatic format, custom print views and child-table cells share it.
 *
 * Returns `null` when there is nothing to print (the caller omits the field).
 * Kinds that are not plain text (images, markdown, key/value metadata) are
 * resolved by `printKind()` and rendered by <PrintValue/>.
 */

/**
 * Fixed default locale: the print view is SSR'd, and server and browser
 * locales differ — an implicit locale would change the text between the two
 * and break hydration. Callers pass `locale` to override.
 */
export const DEFAULT_LOCALE = null; // null → the request's regional locale (core/global/format.js)

const NUMBER_FORMATS = {
  money: { minimumFractionDigits: 2, maximumFractionDigits: 2 },
  decimal: { minimumFractionDigits: 0, maximumFractionDigits: 4 },
  int: { maximumFractionDigits: 0 },
};

/** Column format (`input` with data.format) → print kind. */
const FORMAT_KIND = {
  currency: "money",
  decimal: "decimal", float: "decimal", double: "decimal",
  int: "int", long_int: "int",
  date: "date", datetime: "datetime", time: "time",
  boolean: "bool",
  json: "skip", jsonb: "skip", blob: "skip", password: "skip",
};

/** Element → print kind. Anything writable and not listed prints as text. */
const ELEMENT_KIND = {
  checkbox: "bool", switch: "bool",
  date: "date", date_time: "datetime", time: "time",
  currency: "money", decimal: "decimal", integer: "int",
  textarea: "multiline",
  markdown_input: "markdown",
  image_input: "images",
  file_input: "files", file_uploader: "files",
  metadata: "keyvalue",
  select: "option", radio_group: "option",
  form_table: "table",
  // Not printable: secrets, framework/style fields, rich JSON editors.
  password: "skip", radio_item: "skip", id: "skip", designer: "skip",
  padding: "skip", margin: "skip", tailwind: "skip", slot: "skip",
  text_editor: "skip", icon_input: "skip",
};

export function printKind(element, data = {}) {
  if (element === "input") {
    const format = resolveColumnFormat({ data });
    return FORMAT_KIND[format] || "text";
  }
  return ELEMENT_KIND[element] || "text";
}

export const isEmptyValue = (v) =>
  v === null || v === undefined || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0);

const TRUE_VALUES = new Set([true, 1, "1", "true", "on", "yes"]);

/**
 * @param {string} kind from printKind()
 * @param {*} value raw value as stored (strings from rawValues)
 * @param {object} [opts] { data: field data (select labels), titles, locale }
 *   `titles` = { [Entity]: { [name]: title } } — the `linkTitles` the print
 *   action sends, so entity selects print the linked record's title.
 *   Stored date/time strings are naive (no zone): parsed and formatted in the
 *   runtime's local zone, so the wall time is the same on server and client.
 * @returns {string|null}
 */
export function formatPrintValue(kind, value, { data = {}, titles = null, locale = DEFAULT_LOCALE } = {}) {
  if (kind === "skip") return null;
  if (kind === "bool") return TRUE_VALUES.has(typeof value === "string" ? value.toLowerCase() : value) ? __("Yes") : __("No");
  if (isEmptyValue(value)) return null;

  // Regional settings of the request (language + Company), the same on the
  // server and the client; an explicit `locale` overrides only the locale.
  const r = locale ? { ...regional(), locale } : regional();

  switch (kind) {
    case "money":
      return formatCurrency(value, null, {}, r);
    case "decimal":
    case "int":
      return formatNumber(value, NUMBER_FORMATS[kind], r);
    case "date":
      return formatDate(value, "medium", r);
    case "datetime":
      return formatDateTime(value, "medium", r);
    case "time": {
      const m = /^(\d{1,2}):(\d{2})/.exec(String(value));
      return m ? `${m[1].padStart(2, "0")}:${m[2]}` : String(value);
    }
    case "option":
      return __(optionLabel(value, data, titles));
    default:
      return String(value);
  }
}

/**
 * Label of a select/radio value. Inline options are "value" or "value:Label"
 * per line; the server may also have resolved it into `value_descriptive`.
 * Selects bound to another entity print the linked record's title when
 * `titles` has it, else the stored name.
 */
function optionLabel(value, data = {}, titles = null) {
  if (data.value_descriptive) return String(data.value_descriptive);
  const lines = String(data.options || "").split("\n").map((l) => l.trim()).filter(Boolean);
  if (selectSource(data) === "static") {
    const hit = lines.find((l) => l.split(":")[0] === String(value));
    if (hit) {
      const [v, label] = hit.split(":");
      return label || v;
    }
  }
  if (lines.length === 1) {
    const title = titles?.[lines[0]]?.[String(value)];
    if (title) return String(title);
  }
  return String(value);
}

export const isNumericKind = (kind) => kind === "money" || kind === "decimal" || kind === "int";
