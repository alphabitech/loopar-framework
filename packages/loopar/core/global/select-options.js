'use strict';

/**
 * Lines of a static select / radio group: `value` or `value:Label`, and
 * `# Label` / `# value:Label` headings that open a group. Shared by the
 * server (validation) and the client (src/components/select/options.js).
 */
export function parseOptionLines(text) {
  const out = [];
  let groupValue = null;
  let groupLabel = null;
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      const header = line.replace(/^#+\s*/, "");
      const i = header.indexOf(":");
      groupValue = i >= 0 ? header.slice(0, i).trim() : header;
      groupLabel = i >= 0 ? header.slice(i + 1).trim() : header;
      continue;
    }
    const i = line.indexOf(":");
    out.push({
      value: i >= 0 ? line.slice(0, i) : line,
      label: i >= 0 ? line.slice(i + 1) : line,
      groupValue,
      groupLabel,
    });
  }
  return out;
}

/** Options of the group matching the parent value (all when there are no groups). */
export function optionsForParent(options, parentValue, hasParent) {
  if (!hasParent) return options;
  if (!options.some((o) => o.groupValue != null)) return options;
  if (parentValue === undefined || parentValue === null || parentValue === "") return [];
  return options.filter((o) => String(o.groupValue) === String(parentValue));
}
