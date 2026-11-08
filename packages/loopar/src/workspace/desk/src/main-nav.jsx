import {DeskLogo} from './desk-logo';
import { MenuIcon, XIcon, PanelLeftCloseIcon, PanelLeftOpenIcon } from 'lucide-react';
import { useWorkspace } from "@workspace/workspace-provider"
import { __ } from "@global/i18n";

export function MainNav({ className = "", logo = true }) {
  const { openNav, setOpenNav } = useWorkspace();
  // Mobile: drawer (☰/✕). Desktop: collapsible panel (Slack/VS Code icon).
  const MobileIcon = openNav ? XIcon : MenuIcon;
  const DesktopIcon = openNav ? PanelLeftCloseIcon : PanelLeftOpenIcon;

  return (
    <div className={`flex items-center gap-1 ${className}`}>
      <button
        type="button"
        aria-label={openNav ? "Collapse sidebar" : "Expand sidebar"}
        title={__("Toggle sidebar (Ctrl/Cmd+B)")}
        className="flex h-9 w-9 items-center justify-center rounded-md hover:bg-secondary/60 hover:text-primary"
        onClick={()=>{
          setOpenNav(!openNav)
        }}
      >
        <MobileIcon className="h-5 w-5 lg:hidden" />
        <DesktopIcon className="hidden h-5 w-5 lg:block" />
      </button>
      {logo && <DeskLogo />}
    </div>
  )
}
