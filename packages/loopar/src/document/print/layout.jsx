import { useMemo } from "react";
import loopar from "loopar";
import MetaComponent from "@meta-component";
import DeskUI from "../chrome/desk-ui";
import { defineLayout } from "../base/define-layout";
import { ViewOptionsScope } from "../base/view-options";
import { PrintHeader, PrintStructure } from "./structure";
import { PrintRecordProvider, indexFields } from "./record";
import { LetterheadBlock, LetterheadFooter } from "./letterhead";
import { usePersist } from "@services/persist-state";
import { Button } from "@cn/components/ui/button";
import { PrinterIcon } from "lucide-react";
import { __ } from "@global/i18n";

export const PAPER_SIZES = {
  letter: { label: "Letter", css: "letter", width: "8.5in", height: "11in" },
  legal: { label: "Legal", css: "legal", width: "8.5in", height: "14in" },
  a4: { label: "A4", css: "A4", width: "210mm", height: "297mm" },
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
  const sheetWidth = landscape ? size.height : size.width;
  const pageCss = `@page { size: ${size.css} ${landscape ? "landscape" : "portrait"}; margin: ${MARGIN}; }`;

  const record = useMemo(() => ({
    Document,
    data: Document.data || {},
    fields: indexFields(ctrl.__STRUCTURE__),
    letterhead: print.letterhead ?? null,
  }), [Document, ctrl, print.letterhead]);

  const printUrl = (formatName) =>
    `/desk/${entity}/print?name=${encodeURIComponent(Document.name)}&format=${encodeURIComponent(formatName)}`;

  const toolbar = useMemo(() => ({
    printFormat: formats.length > 0 && Document.name ? (
      <select
        key="printFormat"
        aria-label={__("Print format")}
        className={selectClass}
        value={format?.name || STANDARD}
        onChange={(e) => loopar.navigate(printUrl(e.target.value))}
      >
        <option value={STANDARD}>{__("Standard")}</option>
        {formats.map((f) => <option key={f.name} value={f.name}>{f.name}{f.is_default ? " (default)" : ""}</option>)}
      </select>
    ) : null,
    printPaper: (
      <select key="printPaper" aria-label={__("Paper size")} className={selectClass} value={paper}
        disabled={!!format?.paper_size} onChange={(e) => setPaper(e.target.value)}>
        {Object.entries(PAPER_SIZES).map(([key, p]) => <option key={key} value={key}>{p.label}</option>)}
      </select>
    ),
    printOrientation: (
      <select key="printOrientation" aria-label={__("Orientation")} className={selectClass} value={orientation}
        disabled={!!format?.orientation} onChange={(e) => setOrientation(e.target.value)}>
        <option value="portrait">{__("Portrait")}</option>
        <option value="landscape">{__("Landscape")}</option>
      </select>
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [Document.name, entity, formats, format, paper, orientation, setPaper, setOrientation]);

  // The sheet's Print is the page's primary action (the only filled button).
  const printNow = (
    <Button key="printNow" onClick={() => window.print()}>
      <PrinterIcon className="pr-1" />
      {__("Print")}
    </Button>
  );

  return (
    <ViewOptionsScope defaults={{ actions: toolbar, primaryAction: printNow }}>
      <DeskUI docRef={ctrl}>
        <style>{pageCss}</style>
        <div className="lp-print-stage">
          <article className="lp-print-sheet" data-print-sheet style={{ "--lp-sheet-width": sheetWidth, "--lp-page-margin": MARGIN }}>
            <PrintRecordProvider value={record}>
              {format ? <DesignedFormat format={format} /> : (children ?? <AutomaticFormat ctrl={ctrl} />)}
            </PrintRecordProvider>
          </article>
        </div>
      </DeskUI>
    </ViewOptionsScope>
  );
}, { hasSidebar: false, hasHistory: false, canUpdate: false });
