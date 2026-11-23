'use strict';

import { isListableField } from './list-settings.js';
import { filterKind } from './list-filters.js';
import { parseOptionLines } from './select-options.js';
import { isComputedField } from './formula.js';

/**
 * Import of records into a list from a spreadsheet — the rules the server
 * (which writes them) and the client (which maps the file's columns) share.
 */
export const MAX_IMPORT_ROWS = 5000;
export const IMPORT_MODES = Object.freeze(["insert", "upsert"]);

const truthy = (value) => [1, "1", true, "true"].includes(value);
const YES = new Set(["1", "true", "yes", "y", "si", "sí", "x"]);
const NO = new Set(["0", "false", "no", "n", ""]);
const fold = (value) => String(value ?? "").trim().toLowerCase();

/**
 * Whether a field (`{ element, data }`) can be filled from a file: a plain
 * value a person may write — not a secret, not hidden, not computed, not
 * read-only. `name` is always importable: it is what tells an update from a
 * new record.
 */
export function isImportableField(field) {
  const data = field?.data || {};
  if (data.name === "name") return true;
  if (!isListableField(field) || field.element === "id") return false;
  if (truthy(data.readonly) || isComputedField(data)) return false;
  if (![undefined, null, "", "editable", "create_only"].includes(data.write_policy)) return false;
  return true;
}

/**
 * The field a file column fills, by its header: the field's name or its
 * label, ignoring case and the space/underscore difference. `fields`:
 * `[{ name, label }]`. → field name or null.
 */
export function matchImportColumn(header, fields = []) {
  const key = fold(header).replace(/[\s_]+/g, " ");
  if (!key) return null;
  const same = (text) => fold(text).replace(/[\s_]+/g, " ") === key;
  return (fields.find((f) => same(f.name)) || fields.find((f) => same(f.label)))?.name || null;
}

/**
 * A cell as the field stores it. → `{ value }`, or `{ issue }` when the text
 * can't be that kind of value. Choices accept the option's value or its
 * label; linked records are resolved by the caller (`kind: "choice"` without
 * inline options passes as written).
 */
export function importValue(raw, field) {
  const text = String(raw ?? "").trim();
  const kind = filterKind(field);

  if (kind === "bool") {
    const key = fold(text);
    if (YES.has(key)) return { value: 1 };
    if (NO.has(key)) return { value: 0 };
    return { issue: `"${text}" is not yes or no` };
  }
  if (text === "") return { value: "" };

  if (kind === "number") {
    // Thousands separators and a currency sign are how spreadsheets print numbers.
    const plain = text.replace(/^[^\d+\-.]+|[^\d.]+$/g, "").replace(/,(?=\d{3}(\D|$))/g, "");
    const n = Number(plain);
    return plain !== "" && Number.isFinite(n) ? { value: n } : { issue: `"${text}" is not a number` };
  }

  if (kind === "date" || kind === "datetime") {
    const m = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
    if (!m) return { issue: `"${text}" is not a date (use YYYY-MM-DD)` };
    const day = `${m[1]}-${m[2]}-${m[3]}`;
    if (kind === "date") return { value: day };
    return { value: `${day} ${m[4] || "00"}:${m[5] || "00"}:${m[6] || "00"}` };
  }

  if (["select", "radio_group"].includes(field.element) && typeof field.data?.options === "string") {
    const options = parseOptionLines(field.data.options);
    const one = (item) => {
      const key = fold(item);
      return options.find((o) => fold(o.value) === key) || options.find((o) => fold(o.label) === key) || null;
    };
    if (truthy(field.data.multiple)) {
      const picked = text.split(",").map((item) => item.trim()).filter(Boolean).map((item) => [item, one(item)]);
      const missing = picked.find(([, option]) => !option);
      if (missing) return { issue: `"${missing[0]}" is not an option` };
      return { value: JSON.stringify(picked.map(([, option]) => option.value)) };
    }
    const option = one(text);
    return option ? { value: option.value } : { issue: `"${text}" is not an option` };
  }

  return { value: text };
}
