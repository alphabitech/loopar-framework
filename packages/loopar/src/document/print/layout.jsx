import { useMemo } from "react";
import { useWorkspace } from "@workspace/workspace-provider";
import loopar from "loopar";
import MetaComponent from "@meta-component";
import DeskUI from "../chrome/desk-ui";
import { defineLayout } from "../base/define-layout";
import { ViewOptionsScope } from "../base/view-options";
import { PrintHeader, PrintStructure } from "./structure";
import { PrintRecordProvider, indexFields } from "./record";
import { LetterheadBlock, LetterheadFooter } from "./letterhead";
import { usePersist } from "@services/persist-state";
import { PrinterIcon } from "lucide-react";
import { __ } from "@global/i18n";

export const PAPER_SIZES = {
  letter: { label: "Letter", css: "letter", width: "8.5in", height: "11in" },
  legal: { label: "Legal", css: "legal", width: "8.5in", height: "14in" },
  a4: { label: "A4", css: "A4", width: "210mm", height: "297mm" },
  // Thermal rolls: narrow paper, small margins, compact type (print.css).
  "receipt 80mm": { label: "Receipt 80 mm", css: "80mm 297mm", width: "80mm", height: "297mm", margin: "3mm", roll: true },
  "receipt 58mm": { label: "Receipt 58 mm", css: "58mm 297mm", width: "58mm", height: "297mm", margin: "2mm", roll: true },
};

const MARGIN = "12mm";
const STANDARD = "standard";

const selectClass =
  "h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground disabled:opacity-60";

const lower = (v) => (v ? String(v).toLowerCase() : null);

function DesignedFormat({ format }) {
  const structure = useMemo(() => loopar.utils.JSONparse(format.doc_structure, []) || [], [format.doc_structure]);
  return <MetaComponent elements={structure} />;
}

function AutomaticFormat({ ctrl }) {
  return (
    <>
      <LetterheadBlock />
      <PrintHeader />
      <PrintStructure ctrl={ctrl} />
      <LetterheadFooter />
    </>
  );
}

export const PrintLayout = defineLayout("PrintLayout", ({ ctrl, children }) => {
  const Document = ctrl.Document || {};
  const entity = Document.Entity?.name;
  const print = Document.print || {};
  const format = print.format || null;
  const formats = print.formats || [];

  const [userPaper, setPaper] = usePersist("print:paper", "letter");
  const [userOrientation, setOrientation] = usePersist("print:orientation", "portrait");

  // A format that fixes paper/orientation wins over the user's pick.
  const paper = lower(format?.paper_size) || userPaper;
  const orientation = lower(format?.orientation) || userOrientation;

  const size = PAPER_SIZES[paper] || PAPER_SIZES.letter;
  const landscape = orientation === "landscape";
  const sheetWidth = landscape && !size.roll ? size.height : size.width;
  const margin = size.margin || MARGIN;
  // A roll has no landscape.
  const pageCss = `@page { size: ${size.css}${size.roll ? "" : ` ${landscape ? "landscape" : "portrait"}`}; margin: ${margin}; }`;

  const record = useMemo(() => ({
    Document,
    data: Document.data || {},
    fields: indexFields(ctrl.__STRUCTURE__),
    letterhead: print.letterhead ?? null,
  }), [Document, ctrl, print.letterhead]);

  // Stay in the workspace the sheet is shown in (the portal serves prints too).
  const { workspace } = useWorkspace();
  const portal = workspace === "portal";
  const printUrl = (formatName) =>
    `/${portal ? "portal" : "desk"}/${encodeURIComponent(entity)}/print?name=${encodeURIComponent(Document.name)}&format=${encodeURIComponent(formatName)}`;

  const toolbar = useMemo(() => ({
    // The sheet's Print is the page's primary action (the only filled button).
    printNow: { label: __("Print"), icon: PrinterIcon, primary: true, onClick: () => window.print() },
    printFormat: formats.length > (portal ? 1 : 0) && Document.name ? { render: (
      <select
        key="printFormat"
        aria-label={__("Print format")}
        className={selectClass}
        value={format?.name || STANDARD}
        onChange={(e) => loopar.navigate(printUrl(e.target.value))}
      >
        {/* The portal offers the designed (customer-facing) formats only. */}
        {!portal && <option value={STANDARD}>{__("Standard")}</option>}
        {formats.map((f) => <option key={f.name} value={f.name}>{f.name}{f.is_default ? " (default)" : ""}</option>)}
      </select>
    ) } : null,
    printPaper: { render: (
      <select key="printPaper" aria-label={__("Paper size")} className={selectClass} value={paper}
        disabled={!!format?.paper_size} onChange={(e) => setPaper(e.target.value)}>
        {Object.entries(PAPER_SIZES).map(([key, p]) => <option key={key} value={key}>{p.label}</option>)}
      </select>
    ) },
    printOrientation: { render: (
      <select key="printOrientation" aria-label={__("Orientation")} className={selectClass} value={orientation}
        disabled={!!format?.orientation} onChange={(e) => setOrientation(e.target.value)}>
        <option value="portrait">{__("Portrait")}</option>
        <option value="landscape">{__("Landscape")}</option>
      </select>
    ) },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [Document.name, entity, formats, format, paper, orientation, setPaper, setOrientation, portal]);

  return (
    <ViewOptionsScope defaults={{ actions: toolbar }}>
      <DeskUI docRef={ctrl}>
        <style>{pageCss}</style>
        <div className="lp-print-stage">
          <article className="lp-print-sheet" data-print-sheet data-roll={size.roll ? "" : undefined} style={{ "--lp-sheet-width": sheetWidth, "--lp-page-margin": size.margin || MARGIN }}>
            <PrintRecordProvider value={record}>
              {format ? <DesignedFormat format={format} /> : (children ?? <AutomaticFormat ctrl={ctrl} />)}
            </PrintRecordProvider>
          </article>
        </div>
      </DeskUI>
    </ViewOptionsScope>
  );
}, { hasSidebar: false, hasHistory: false, canUpdate: false });
