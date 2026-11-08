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

export function DropdownListGridActions(props) {
  const {bulkRemove, selectAllVisibleRows, selectedCount, rowsCount, selectorAllStatus} = useTable();
  const {award, __META__} = useWorkspace();
  const entity = __META__.Document?.Entity?.name

  return (
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
  )
}