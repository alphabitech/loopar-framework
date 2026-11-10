import { X } from "lucide-react";
import { __ } from "@global/i18n";

/** Chips of the values of a `multiple` select / connection, each removable. */
export function SelectedChips({ values, labelOf, onRemove, disabled }) {
  if (!values.length) return null;
  return (
    <div className="mb-1 flex flex-wrap gap-1">
      {values.map((v) => (
        <span key={v} className="inline-flex items-center gap-1 rounded-md bg-secondary px-2 py-0.5 text-sm text-secondary-foreground">
          {labelOf(v)}
          {!disabled && (
            <button type="button" aria-label={`${__("Remove")} ${v}`} onClick={() => onRemove(v)} className="opacity-60 hover:opacity-100">
              <X className="size-3" />
            </button>
          )}
        </span>
      ))}
    </div>
  );
}

/** Shared designer fields of `multiple` (select and connection). */
export const multipleMetaFields = () => ({
  multiple: { element: SWITCH, data: { label: "Multiple", description: "Allow several values (stored as a JSON list)." } },
  min_items: { element: INPUT, data: { label: "Min values", format: "int", description: "With Multiple." } },
  max_items: { element: INPUT, data: { label: "Max values", format: "int", description: "With Multiple." } },
  display: {
    element: SELECT,
    data: {
      label: "Display",
      options: "chips:Chips (searchable list)\ncheckboxes:Checkboxes",
      description: "With Multiple: how the choices are shown.",
    },
  },
});
