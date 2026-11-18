import { useTable } from './TableContext';
import { useWorkspace } from "@workspace/workspace-provider";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@cn/components/ui/dropdown-menu";

import { Checkbox } from "@cn/components/ui/checkbox";
import { ChevronDownIcon } from "lucide-react";
import { __ } from "@global/i18n";
import { useState } from "react";
import { ImportDialog } from "./ImportDialog";
import { BulkEditDialog } from "./BulkEditDialog";

export function DropdownListGridActions(props) {
  const {bulkRemove, selectAllVisibleRows, selectedCount, rowsCount, selectorAllStatus, exportCsv} = useTable();
  const {award, __META__} = useWorkspace();
  const entity = __META__.Document?.Entity?.name
  const [importing, setImporting] = useState(false);
  const [editing, setEditing] = useState(false);
  const canBulkEdit = !!exportCsv && !!props.deleteOnServer && !__META__.Document?.Entity?.read_only
    && (!!award(entity, "update") || (!!__META__.Document?.workflow && !!award(entity, "transition")));
  // Records of a read-only entity come from the app's flows, not from a file.
  const canImport = !!exportCsv && !!props.deleteOnServer && !__META__.Document?.Entity?.read_only && !!award(entity, "import");

  return (
    <>
    {importing && <ImportDialog open={importing} onOpenChange={setImporting} />}
    {editing && <BulkEditDialog open={editing} onOpenChange={setEditing} />}
    <DropdownMenu>
      <div className="inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 border border-input bg-background hover:bg-accent hover:text-accent-foreground h-10 py-2 px-2">
        <>
          <Checkbox
            checked={selectorAllStatus}
            onCheckedChange={selectAllVisibleRows}
          />
          <DropdownMenuTrigger asChild className="p-1">
            <div className="flex flex-row pl-2 items-center">
              {selectedCount > 0 && (
                <p className="flex items-center justify-center">
                  {__("Selected")} {selectedCount}
                </p>
              )}
              <ChevronDownIcon className="ml-1" />
            </div>
          </DropdownMenuTrigger>
        </>
      </div>
      <DropdownMenuContent className="w-56">
        <DropdownMenuLabel>{__("Actions")}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem
            disabled={rowsCount === selectedCount}
            onClick={() => selectAllVisibleRows(true)}
          >
            {__("Select All")}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={selectedCount <= 0}
            onClick={() => selectAllVisibleRows(false)}
          >
            {__("Unselect All")}
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          {!!exportCsv && !!props.deleteOnServer && !!award(entity, "export") && <DropdownMenuItem
            onClick={() => exportCsv()}
          >
            {selectedCount > 0 ? __("Export selected (CSV)") : __("Export all (CSV)")}
          </DropdownMenuItem>}
          {canBulkEdit && <DropdownMenuItem disabled={selectedCount <= 0} onClick={() => setEditing(true)}>
            {__("Edit selected…")}
          </DropdownMenuItem>}
          {canImport && <DropdownMenuItem onClick={() => setImporting(true)}>
            {__("Import CSV…")}
          </DropdownMenuItem>}
          {!!award(entity, "bulkDelete") && <DropdownMenuItem
            disabled={selectedCount <= 0}
            onClick={() => {
              bulkRemove(props.deleteOnServer);
            }}
          >
            {__("Bulk Remove")}
          </DropdownMenuItem>}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
    </>
  )
}