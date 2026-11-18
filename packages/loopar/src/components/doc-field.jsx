import loopar from "loopar";
import { cn } from "@cn/lib/utils";
import { usePrintRecord, usePrintDesign, printDesignFieldOptions } from "@loopar/print/record";
import { PrintValue } from "@loopar/print/structure";
import { printKind, isEmptyValue } from "@loopar/print/format-value";

/**
 * Print element: one field of the record being printed (label + formatted
 * value, same formatting as the automatic format). While designing it shows
 * the field it is bound to.
 */
const humanize = (name) => loopar.utils.Capitalize(String(name || "").replaceAll("_", " "));

export default function DocField(props) {
  const data = props.data || {};
  const record = usePrintRecord();
  const design = usePrintDesign();

  const showLabel = !["0", 0, false, "false"].includes(data.show_label);
  const inline = loopar.utils.trueValue(data.inline);
  const className = cn("lp-field", inline && "lp-field-inline", props.className);

  if (!record) {
    const label = data.label || design.fields.find((f) => f.name === data.field)?.label || humanize(data.field);
    return (
      <div className={className}>
        {showLabel && <div className="lp-label">{label || "Field"}</div>}
        <div className="lp-value lp-placeholder-muted">{data.field ? `{${data.field}}` : "Pick a field in the element editor"}</div>
      </div>
    );
  }

  const node = record.fields.get(data.field);
  if (!node) return null;
  // Nothing to print: no label left hanging (a yes/no always has a value).
  if (printKind(node.element, node.data) !== "bool" && isEmptyValue(record.data[data.field])) return null;

  const value = <PrintValue element={node.element} data={node.data} value={record.data[data.field]} />;

  return (
    <div className={className}>
      {showLabel && <div className="lp-label">{data.label || node.data?.label || humanize(data.field)}</div>}
      <div className={node.element === "textarea" ? "lp-value lp-multiline" : "lp-value"}>{value}</div>
    </div>
  );
}

DocField.dontHaveMetaElements = ["name", "text"];

DocField.metaFields = () => [
  {
    group: "content",
    elements: {
      field: { element: SELECT, data: { label: "Field", options: printDesignFieldOptions({ tables: false }) } },
      show_label: { element: SWITCH, data: { label: "Show label", default_value: 1 } },
      inline: { element: SWITCH, data: { label: "Label beside the value" } },
    },
  },
];
