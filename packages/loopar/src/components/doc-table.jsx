import loopar from "loopar";
import { cn } from "@cn/lib/utils";
import { usePrintRecord, usePrintDesign, printDesignFieldOptions } from "@loopar/print/record";
import { PrintTable } from "@loopar/print/structure";

/**
 * Print element: a child table (form_table) of the record being printed.
 * `columns` (comma-separated field names) narrows/orders the columns;
 * empty = the child entity's in_list_view columns.
 */
export default function DocTable(props) {
  const data = props.data || {};
  const record = usePrintRecord();
  const design = usePrintDesign();

  if (!record) {
    const label = data.label || design.fields.find((f) => f.name === data.field)?.label || data.field;
    return (
      <div className={cn("lp-block lp-placeholder", props.className)}>
        {label ? `Table: ${label}` : "Pick a child table in the element editor"}
        {data.columns ? ` (${data.columns})` : ""}
      </div>
    );
  }

  const node = record.fields.get(data.field);
  if (!node || node.element !== "form_table") return null;
  // An empty table is left out, as in the stored snapshot (core/document/print-format.js).
  const value = record.data[data.field];
  const rows = typeof value === "string" ? loopar.utils.JSONparse(value, []) : value;
  if (!Array.isArray(rows) || !rows.length) return null;

  const columns = String(data.columns || "").split(",").map((c) => c.trim()).filter(Boolean);
  const showLabel = !["0", 0, false, "false"].includes(data.show_label);

  return (
    <div className={cn("lp-block", props.className)}>
      {showLabel && (data.label || node.data?.label) && <div className="lp-label">{data.label || node.data.label}</div>}
      <PrintTable el={node} value={record.data[data.field]} columns={columns.length ? columns : null} />
    </div>
  );
}

DocTable.dontHaveMetaElements = ["name", "text"];

DocTable.metaFields = () => [
  {
    group: "content",
    elements: {
      field: { element: SELECT, data: { label: "Child table", options: printDesignFieldOptions({ tables: true }) } },
      columns: {
        element: INPUT,
        data: { label: "Columns", placeholder: "work, quantity, amount", description: "Field names of the child entity, comma-separated. Empty = its list columns." },
      },
      show_label: { element: SWITCH, data: { label: "Show label", default_value: 1 } },
    },
  },
];
