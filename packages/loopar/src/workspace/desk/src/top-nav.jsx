import { MainNav } from "./main-nav"
import { ThemeToggle } from "@workspace/theme-toggle"
import { AppsMenu } from "./apps-menu"
import { UserInfo } from "./user-info"
import { CommandPalette } from "./command-palette"
import { DebugChip } from "./debug-chip"
import { useWorkspace } from "@workspace/workspace-provider"

/**
 * Content header (Slack/Discord layout): on lg it starts where the sidebar
 * ends — brand and sidebar toggle live at the top of the sidebar. On mobile
 * the sidebar is a drawer, so the header keeps the toggle and the logo.
 */
export function TopNav() {
  const { openNav } = useWorkspace();
  return (
    <header className={`sticky top-0 z-40 w-full border-b bg-background/80 backdrop-blur-sm duration-100 ease-in ${openNav ? "lg:pl-sidebar-width" : "lg:pl-collapse-sidebar-width"}`}>
      <div className="flex h-header-height items-center space-x-4 px-2 sm:justify-between sm:space-x-0">
        <MainNav className="lg:hidden" />
        <div className="flex flex-1 items-center justify-end space-x-4">
          <CommandPalette />
          <nav className="flex items-center space-x-1">
            <DebugChip />
            <AppsMenu />
            <ThemeToggle />
            <UserInfo />
          </nav>
        </div>
      </div>
    </header>
  )
}
