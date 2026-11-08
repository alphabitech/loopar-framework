import { cn } from "@cn/lib/utils";
import { usePrintRecord, usePrintDesign } from "@loopar/print/record";
import { PrintStructure } from "@loopar/print/structure";
import { __ } from "@global/i18n";

/**
 * Print element: the automatic format's body (every non-empty field of the
 * record, laid out like its form). Handy to wrap it with a letterhead,
 * a header and closing text without placing each field.
 */
export default function DocBody(props) {
  const record = usePrintRecord();
  const design = usePrintDesign();

  if (!record) {
    return (
      <div className={cn("lp-placeholder", props.className)}>
        {__("All fields of")} {design.entity || "the entity"} {__("(automatic layout)")}
      </div>
    );
  }

  return (
    <div className={props.className}>
      <PrintStructure />
    </div>
  );
}

DocBody.dontHaveMetaElements = ["name", "text", "label"];
