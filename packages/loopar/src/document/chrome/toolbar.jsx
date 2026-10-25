import { useState } from "react";
import { Popover, PopoverTrigger, PopoverContent } from "@cn/components/ui/popover";
import { Button } from "@cn/components/ui/button";
import { MoreHorizontalIcon } from "lucide-react";
import { cn } from "@cn/lib/utils";

const MenuEntries = ({ entries, className = "" }) => entries.map(([key, node]) => (
  <div key={key} className={cn("lp-toolbar-menu-item flex empty:hidden [&>*]:w-full [&>*]:justify-start", className)}>
    {node}
  </div>
));

/**
 * Header toolbar. `inline` entries sit in the row on sm+ and move into the "⋯"
 * menu on phones; `menu` entries always live in the menu.
 */
export function Toolbar({ inline = [], menu = [], toggle = null, primary = null, className = "" }) {
  const [open, setOpen] = useState(false);
  const hasMenu = menu.length > 0;
  const hasInline = inline.length > 0;

  return (
    <div className={cn("lp-toolbar flex shrink-0 flex-row items-center gap-[6px]", className)}>
      {inline.map(([key, node]) => (
        <div key={key} className="lp-toolbar-item flex shrink-0 items-center empty:hidden max-sm:hidden">
          {node}
        </div>
      ))}

      {(hasMenu || hasInline) && (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="secondary"
              className={cn("shrink-0 px-2", !hasMenu && "sm:hidden")}
              aria-label="More actions"
              title="More actions"
            >
              <MoreHorizontalIcon />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            className="flex w-auto min-w-48 flex-col items-stretch gap-1 p-1"
            onClick={(e) => { if (e.target.closest?.("button, a")) setOpen(false); }}
            onCloseAutoFocus={(e) => e.preventDefault()}
          >
            <MenuEntries entries={inline} className="sm:hidden" />
            {hasMenu && hasInline && <div role="separator" className="my-1 h-px bg-border sm:hidden" />}
            <MenuEntries entries={menu} />
          </PopoverContent>
        </Popover>
      )}

      {toggle && <div className="flex shrink-0 items-center empty:hidden">{toggle}</div>}

      {primary && <div className="flex shrink-0 flex-row items-center gap-[6px] empty:hidden">{primary}</div>}
    </div>
  );
}
