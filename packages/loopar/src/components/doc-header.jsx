import { cn } from "@cn/lib/utils";
import { usePrintRecord, usePrintDesign, printDesignFieldOptions } from "@loopar/print/record";
import { PrintHeader } from "@loopar/print/structure";

/**
 * Print element: document title block (title, record name, print date).
 * The title is the field named in "Title from field" when the record has a
 * value there (e.g. a document whose kind changes its title), else "Title".
 */
export default function DocHeader(props) {
  const data = props.data || {};
  const record = usePrintRecord();
  const design = usePrintDesign();

  if (!record) {
    return (
      <header className={cn("lp-header", props.className)}>
        <div>
          <div className="lp-title">{data.label || design.entity || "Document"}</div>
          <div className="lp-subtitle lp-placeholder-muted">{"{name}"}</div>
        </div>
        <div className="lp-header-aside lp-placeholder-muted">{"{date}"}</div>
      </header>
    );
  }

  const fromField = data.title_field ? record.data?.[data.title_field] : null;
  return (
    <div className={props.className}>
      <PrintHeader title={(fromField && String(fromField)) || data.label || undefined} />
    </div>
  );
}

DocHeader.dontHaveMetaElements = ["name", "text"];

DocHeader.metaFields = () => [
  {
    group: "content",
    elements: {
      label: { element: INPUT, data: { label: "Title", placeholder: "Empty = entity name" } },
      title_field: { element: SELECT, data: { label: "Title from field", description: "When the record has a value in this field, it is the title.", options: printDesignFieldOptions({ tables: false }) } },
    },
  },
];
