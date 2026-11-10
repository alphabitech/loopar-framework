/**
 * Multi-line text fields ("one item per line", optional "a | b" columns).
 * Authors edit them as a single textarea, so the whole list is one
 * translatable text in the content layer.
 */
export function parseLines(value, columns = 1) {
  return String(value ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      if (columns <= 1) return [line];
      const parts = line.split("|").map((p) => p.trim());
      return [...parts.slice(0, columns - 1), parts.slice(columns - 1).join(" | ")];
    });
}

/** Truthy for the values switches store (1, "1", true, "true"). */
export const isOn = (v) => v === true || v === 1 || v === "1" || v === "true";

export { rootProps } from "./root-props.js";
