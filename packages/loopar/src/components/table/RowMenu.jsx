import { useState } from "react";
import { Link } from "@link";
import { Button } from "@cn/components/ui/button";
import { Popover, PopoverTrigger, PopoverContent } from "@cn/components/ui/popover";
import { MoreHorizontalIcon, PencilIcon, EyeIcon, PrinterIcon, Trash2Icon } from "lucide-react";
import { canOn } from "@context/auth-context";
import { useViewOptions } from "@loopar/document";
import { cn } from "@cn/lib/utils";
import { __ } from "@global/i18n";

const Entry = ({ children, className = "" }) => (
  <div className={cn("lp-toolbar-menu-item flex empty:hidden [&>*]:w-full [&>*]:justify-start", className)}>{children}</div>
);

export function RowMenu({ row, Entity = {}, onDelete }) {
  const [open, setOpen] = useState(false);
  const { rowActions } = useViewOptions();

  const custom = Object.entries((typeof rowActions === "function" ? rowActions(row) : rowActions) || {})
    .filter(([, node]) => node);

  const name = encodeURIComponent(row.name);
  const canEdit = !Entity.read_only && canOn(Entity.name, "update", row);
  const canPrint = !Entity.is_single && !Entity.is_builder && canOn(Entity.name, "print", row);
  const canDelete = canOn(Entity.name, "delete", row);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          className={cn(
            "h-8 w-8 p-0",
            "[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100",
            "focus-visible:opacity-100 data-[state=open]:opacity-100",
          )}
          aria-label={__("Row actions")}
          title={__("Actions")}
        >
          <MoreHorizontalIcon />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="flex w-auto min-w-44 flex-col items-stretch gap-1 p-1"
        // Close after the action's own handler ran; no focus return (it would dismiss a confirm dialog).
        onClick={(e) => { if (e.target.closest?.("button, a")) setOpen(false); }}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        {custom.map(([key, node]) => <Entry key={key}>{node}</Entry>)}
        {custom.length > 0 && <div role="separator" className="my-1 h-px bg-border" />}

        <Entry>
          {canEdit ? (
            <Link variant="ghost" to={`update?name=${name}`}><PencilIcon />{__("Edit")}</Link>
          ) : (
            <Link variant="ghost" to={`view?name=${name}`}><EyeIcon />{__("View")}</Link>
          )}
        </Entry>
        {canPrint && (
          <Entry>
            <Link variant="ghost" to={`print?name=${name}`}><PrinterIcon />{__("Print")}</Link>
          </Entry>
        )}
        {canDelete && (
          <Entry>
            <Button variant="ghost" className="text-red-500 hover:text-red-500" onClick={(e) => { e.preventDefault(); onDelete?.(row); }}>
              <Trash2Icon />{__("Delete")}
            </Button>
          </Entry>
        )}
      </PopoverContent>
    </Popover>
  );
}
