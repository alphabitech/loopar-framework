import MetaComponent from "@meta-component";
import DeskUI from "../chrome/desk-ui";
import { defineLayout } from "../base/define-layout";
import { useDocument } from "../base/provider";

/**
 * Desk Page document: AppBar (the page title) + its blocks stacked with the
 * app's gap (the same value rows use between columns), no history. Rows of
 * cards would otherwise touch.
 */
function DeskPageBody({ ctrl, children }) {
  const { spacing = {} } = useDocument();
  const gap = Number(spacing.gap ?? 1);

  return (
    <DeskUI docRef={ctrl}>
      <div className="flex w-full flex-col" style={{ rowGap: `${Number.isFinite(gap) ? gap : 1}rem` }}>
        <MetaComponent elements={ctrl.__STRUCTURE__} parent={ctrl} />
        {children}
      </div>
    </DeskUI>
  );
}

export const DeskPageLayout = defineLayout("DeskPageLayout", DeskPageBody);
