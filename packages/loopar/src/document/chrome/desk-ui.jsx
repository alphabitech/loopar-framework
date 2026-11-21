import { useCallback, useEffect, useState } from "react";
import { AppBar } from "./app-bar";
import { SidePanelContext } from "./side-panel";
import { PageTrail } from "./trail";
import { XIcon } from "lucide-react";
import { Button } from "@cn/components/ui/button";
import { useDocument, useViewOptions } from "@loopar/document";
import { usePersist } from "@services/persist-state";
import { cn } from "@cn/lib/utils";
import { __ } from "@global/i18n";

/** Room for a docked fixed panel (the designer's, components/designer/sidebar). */
const DESIGNER_WIDTH = "lg:w-[calc(100%-300px)]";
const LG = "(min-width: 1024px)";

/** Matches `lg` after hydration (false on the server and on the first render). */
function useIsLg() {
  const [lg, setLg] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(LG);
    const sync = () => setLg(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return lg;
}

/**
 * Record panel: information about the record, never actions — the view's
 * `summary` (state, amounts, dates…) and its activity (Document History).
 * Beside the content on lg, fixed in view while the document scrolls (own
 * scroll when taller than the screen); a drawer below lg. `open`: undefined =
 * the default (open on lg, closed below), else the user's choice.
 */
function RecordPanel({ open, onClose, summary, history }) {
  if (open === false) return null;

  return (
    <>
      {open === true && <div className="fixed inset-0 z-40 bg-black/40 lg:hidden" onClick={onClose} aria-hidden="true" />}
      <aside
        data-print-hide
        aria-label={__("Details")}
        className={cn(
          "flex flex-col gap-6",
          "min-w-0 overflow-x-hidden [overflow-wrap:anywhere] lg:sticky lg:top-[calc(var(--spacing-header-height)+0.5rem)] lg:max-h-[calc(100vh-var(--spacing-header-height)-1rem)] lg:w-80 lg:shrink-0 lg:self-start lg:overflow-y-auto lg:border-l lg:pl-6",
          "max-lg:fixed max-lg:inset-y-0 max-lg:right-0 max-lg:z-50 max-lg:w-[min(22rem,90vw)] max-lg:overflow-y-auto max-lg:border-l max-lg:bg-background max-lg:p-4 max-lg:shadow-xl",
          open === undefined && "max-lg:hidden"
        )}
      >
        <div className="flex items-center justify-between lg:hidden">
          <span className="font-semibold">{__("Details")}</span>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label={__("Close")}>
            <XIcon />
          </Button>
        </div>
        {summary && <section className="flex flex-col gap-3">{summary}</section>}
        {history}
      </aside>
    </>
  );
}

export default function DeskUI(props) {
  const docRef = props.docRef;
  const { Document = {}, inModal } = useDocument();
  // Docked panels mounted (useReserveSidePanel): the designer's.
  const [docked, setDocked] = useState(0);
  const reserve = useCallback((delta) => setDocked((n) => Math.max(0, n + delta)), []);
  const options = useViewOptions();
  const isLg = useIsLg();
  const [panelOpen, setPanelOpen] = usePersist(`${Document.Entity?.name || "document"}:recordPanel`);

  const hasHeader = options.hasHeader !== false;
  const hasBreadcrumb = options.hasBreadcrumb !== false;
  const action = Document.meta?.action;

  // A docked panel (the designer's) takes the right side while it is mounted.
  const designerOpen = !inModal && docked > 0;

  const summary = typeof options.summary === "function" ? options.summary() : options.summary;
  const history = options.hasHistory !== false && ["update", "view"].includes(action)
    ? docRef?.getDocumentHistory?.(false, { panel: true })
    : null;
  const panelAvailable = !inModal && options.hasSidebar !== false && !designerOpen && !!(summary || history);

  const shown = panelOpen ?? isLg;
  const panel = panelAvailable ? {
    available: true,
    open: shown,
    toggle: () => setPanelOpen(!(panelOpen ?? window.matchMedia(LG).matches)),
  } : null;

  return (
    <SidePanelContext.Provider value={inModal ? null : reserve}>
    <div className={cn("flex w-full flex-1 flex-row items-start gap-6", designerOpen && DESIGNER_WIDTH)}>
      <div className="flex min-w-0 flex-1 flex-col space-y-3">
        {/* Headerless documents still say where they sit, in the top bar. */}
        {!hasHeader && hasBreadcrumb && <PageTrail />}
        {hasHeader &&
          <AppBar
            Document={docRef.Document}
            viewTypeToggle={props.viewTypeToggle}
            setViewType={props.setViewType}
            viewType={props.viewType}
            applyView={props.applyView}
            panel={panel}
            hasBreadcrumb={hasBreadcrumb}
          />
        }
        {props.children}
      </div>
      {panelAvailable && (
        <RecordPanel open={panelOpen} onClose={() => setPanelOpen(false)} summary={summary} history={history} />
      )}
    </div>
    </SidePanelContext.Provider>
  );
}
