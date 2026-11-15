import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@cn/components/ui/dropdown-menu";
import { Columns3Icon } from "lucide-react";
import { useMemo } from "react";
import { listColumnChoices, resolveListColumns } from "@global/list-settings";
import { __ } from "@global/i18n";
import { useTable } from "./TableContext";
import { titleFieldsOf } from "./list-columns.js";

/**
 * Which columns the user sees in this list: the entity's list columns can be
 * hidden, any other plain field can be added. Saved per user
 * (global/list-settings.js).
 */
export function ListColumnsMenu() {
  const { baseColumns, Document, listSettings, saveListSettings } = useTable();

  const { choices, visible } = useMemo(() => {
    const fields = baseColumns();
    // Title fields live in the title column, which is always shown.
    const titleFields = titleFieldsOf(Document?.Entity);
    return {
      choices: listColumnChoices(fields).filter((c) => !titleFields.includes(c.field.data.name)),
      visible: new Set(resolveListColumns(fields, listSettings).map((col) => col.data.name)),
    };
  }, [baseColumns, Document?.Entity, listSettings]);

  if (!saveListSettings || choices.length === 0) return null;

  const without = (list, name) => list.filter((n) => n !== name);

  const toggle = ({ field, isDefault }, checked) => {
    const name = field.data.name;
    if (isDefault) {
      const hidden = without(listSettings.hidden, name);
      return saveListSettings({ hidden: checked ? hidden : [...hidden, name] });
    }
    const shown = without(listSettings.shown, name);
    // A column added by the user needs its values: fetch the list again.
    return saveListSettings({ shown: checked ? [...shown, name] : shown }, { reload: checked });
  };

  const customized = listSettings.order.length > 0 || listSettings.hidden.length > 0
    || listSettings.shown.length > 0 || Object.keys(listSettings.widths).length > 0;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title={__("Columns")}
          aria-label={__("Columns")}
          className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-input bg-background text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Columns3Icon className="h-4 w-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-96 w-56 overflow-y-auto">
        <DropdownMenuLabel>{__("Columns")}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {choices.map((choice) => {
          const name = choice.field.data.name;
          return (
            <DropdownMenuCheckboxItem
              key={name}
              checked={visible.has(name)}
              onCheckedChange={(checked) => toggle(choice, !!checked)}
              // Keep the menu open: several columns are usually changed at once.
              onSelect={(e) => e.preventDefault()}
            >
              <span className="truncate">{__(choice.field.data.label || name)}</span>
            </DropdownMenuCheckboxItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={!customized}
          onClick={() => saveListSettings({ order: [], hidden: [], shown: [], widths: {} })}
        >
          {__("Reset columns")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
