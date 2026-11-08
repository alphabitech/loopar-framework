import { usePrintRecord } from "@loopar/print/record";
import { __ } from "@global/i18n";

/** Print element: forces the next content onto a new page. */
export default function PageBreak() {
  const record = usePrintRecord();
  if (!record) return <div className="lp-page-break-design">{__("Page break")}</div>;
  return <div className="lp-page-break" />;
}

PageBreak.dontHaveMetaElements = ["name", "text", "label"];
