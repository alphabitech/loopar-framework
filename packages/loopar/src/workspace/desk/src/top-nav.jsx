import { MainNav } from "./main-nav"
import { ThemeToggle } from "@workspace/theme-toggle"
import { AppsMenu } from "./apps-menu"
import { UserInfo } from "./user-info"
import { CommandPalette } from "./command-palette"
import { DebugChip } from "./debug-chip"
import { NotificationBell } from "./notification-bell"
import { AppCrumb } from "./app-crumb"
import { Link } from "@link"
import { ChevronRightIcon } from "lucide-react"
import { __ } from "@global/i18n"
import { versioned } from "@global/assets-version";

/** Where the document header puts its breadcrumbs. */
export const DESK_TRAIL_SLOT = "desk-trail"

/**
 * Desk top bar, full width over the sidebar: brand + sidebar toggle, the
 * trail (app selector › the active document's breadcrumbs), then search and
 * the user's tools. The sidebar starts below it.
 */
export function TopNav() {
  return (
    <header className="sticky top-0 z-40 w-full border-b bg-background/80 backdrop-blur-sm">
      <div className="flex h-header-height items-center gap-2 pr-2 sm:justify-between">
        {/* One row, left to right: sidebar toggle · logo › app (selector) › the document's breadcrumbs. */}
        <div className="flex shrink-0 items-center gap-1 pl-2">
          <MainNav logo={false} />
          <Link award={false} bare to="/desk" title={__("Desk")} className="flex h-9 shrink-0 items-center justify-center px-1">
            <img src={versioned("/assets/public/images/logo-dark-min.svg")} alt={__("Loopar")} className="h-7 w-8" loading="lazy" decoding="async" />
          </Link>
          <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground opacity-60 max-sm:hidden" aria-hidden="true" />
        </div>
        {/* Trail: the app (selector), then the active document's breadcrumbs (document/chrome/app-bar, via a portal). */}
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <div className="flex min-w-0 shrink-0 items-center max-sm:hidden"><AppCrumb /></div>
          <div id={DESK_TRAIL_SLOT} className="flex min-w-0 items-center" />
        </div>
        <div className="flex shrink-0 items-center justify-end gap-2 sm:gap-4">
          <CommandPalette />
          <nav className="flex items-center space-x-1">
            {/* Phones: no room next to the trail and the user's tools. */}
            <span className="contents max-sm:hidden"><DebugChip /></span>
            <NotificationBell />
            <AppsMenu />
            <ThemeToggle />
            <UserInfo />
          </nav>
        </div>
      </div>
    </header>
  )
}
