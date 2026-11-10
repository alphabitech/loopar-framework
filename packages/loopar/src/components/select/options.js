import { __ } from "@global/i18n";
import { parseOptionLines, optionsForParent } from "@global/select-options";

/**
 * Choices of a static select / radio group.
 *
 * Text form (designer): one option per line, `value` or `value:Label`.
 * A line starting with `#` opens a group: `# Label` or `# value:Label`.
 * With a `parent` field, a group's value is the parent value it belongs to
 * (`# HN:Honduras` → its cities show when the parent field is "HN").
 *
 * Code may pass an array ({ value, label, group } or strings) or a
 * { value: label } object.
 */
export function parseStaticOptions(options) {
  if (!options) return [];

  if (Array.isArray(options)) {
    return options.map((o) => (o && typeof o === "object")
      ? { value: o.value, label: o.label ?? o.value, group: o.group ?? null, groupValue: o.groupValue ?? o.group ?? null }
      : { value: o, label: __(String(o)), group: null, groupValue: null });
  }

  if (typeof options === "object") {
    return Object.entries(options).map(([value, label]) => ({ value, label, group: null, groupValue: null }));
  }

  return parseOptionLines(options).map((o) => ({
    value: o.value,
    label: __(o.label),
    group: o.groupLabel != null ? __(o.groupLabel) : null,
    groupValue: o.groupValue,
  }));
}

export { optionsForParent };

/** [{ group, options }] in first-appearance order; ungrouped options under `null`. */
export function groupOptions(options) {
  const groups = new Map();
  for (const o of options) {
    const key = o?.group ?? null;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(o);
  }
  return [...groups.entries()].map(([group, items]) => ({ group, options: items }));
}
