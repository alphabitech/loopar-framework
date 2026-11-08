import {useState} from "react"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@cn/components/ui/dropdown-menu"

import {Link} from "@link"
import { buttonVariants } from "@cn/components/ui/button"
import { 
  ComponentIcon, CircuitBoardIcon, FilesIcon, LayoutGridIcon, Settings2Icon, 
  User2Icon, CogIcon, ServerCogIcon, BrushIcon, LockKeyhole, ChartSpline, StarIcon, PrinterIcon, BugIcon, DatabaseBackupIcon
} from "lucide-react"
import { __ } from "@global/i18n";

const MakeButton = ({ Icon, text, link}) => (
  <Link
    to={link}
    variant="ghost"
  >
    <Icon className="h-10 w-10" />
    <span className="w-full px-2">{text}</span>
  </Link>
)

export function AppsMenu() {
  const [open, setOpen] = useState(false);
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <div
          className={`${buttonVariants({
            size: "icon",
            variant: "ghost",
          })} cursor-pointer`}
        >
          <LayoutGridIcon />
          <span className="sr-only">{__("Home")}</span>
        </div>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="bg-card">
        <div className="grid grid-cols-2 p-2" onClick={() => setOpen(false)}>
          <MakeButton Icon={BrushIcon} text="Entities" link="/desk/Entity/list"/>
          <MakeButton Icon={CogIcon} text="Builders" link="/desk/Builder/list"/>
          <MakeButton Icon={CircuitBoardIcon} text="Apps" link="/desk/App Manager/view"/>
          <MakeButton Icon={ComponentIcon} text="Modules" link="/desk/Module/list" />
          <MakeButton Icon={Settings2Icon} text="Settings" link="/desk/System Settings/update" />
          <MakeButton Icon={FilesIcon} text="Files" link="/desk/File Manager/list" />
          <MakeButton Icon={ServerCogIcon} text="Tenant Manager" link="/desk/Tenant Manager/list" />
          <MakeButton Icon={ChartSpline} text="Analytics" link="/desk/Analytics Dashboard/view" />
          <MakeButton Icon={User2Icon} text="Users" link="/desk/user/list" />
          <MakeButton Icon={LockKeyhole} text="Auth Manager" link="/desk/Role Permission Manager/view" />
          <MakeButton Icon={StarIcon} text="Reviews" link="/desk/Review/list" />
          <MakeButton Icon={PrinterIcon} text="Print Formats" link="/desk/Print Format Builder/list" />
          <MakeButton Icon={BugIcon} text="Debugger" link="/desk/Debugger/view" />
          <MakeButton Icon={DatabaseBackupIcon} text="Backups" link="/desk/Backups/view" />
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
