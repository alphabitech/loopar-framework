import { useMemo } from "react";
import loopar from "loopar";
import MetaComponent from "@meta-component";
import { PrintRecordProvider, indexFields } from "./record";

/**
 * A printed record outside the desk's print entry: the paper sheet of a
 * snapshot made on the server (core/document/print-format.js printSnapshot)
 * — the Print Format, the record's values and labels, and the letterhead as
 * they were when it was made. Same components and paper styles as the desk
 * print, so a copy sent to sign looks like the one the office prints.
 */
export function PrintSheet({ snapshot, className = "" }) {
  const elements = useMemo(
    () => loopar.utils.JSONparse(snapshot?.format?.doc_structure, []) || [],
    [snapshot?.format?.doc_structure]
  );

  const record = useMemo(() => ({
    Document: {
      name: snapshot?.name,
      Entity: { name: snapshot?.entity },
      linkTitles: snapshot?.linkTitles || {},
      printedAt: snapshot?.printed_at || null,
    },
    data: snapshot?.data || {},
    fields: indexFields(loopar.utils.JSONparse(snapshot?.structure, []) || []),
    letterhead: snapshot?.letterhead ?? null,
  }), [snapshot]);

  if (!snapshot) return null;

  return (
    <article className={`lp-print-sheet ${className}`.trim()} data-print-sheet>
      <PrintRecordProvider value={record}>
        <MetaComponent elements={elements} />
      </PrintRecordProvider>
    </article>
  );
}
