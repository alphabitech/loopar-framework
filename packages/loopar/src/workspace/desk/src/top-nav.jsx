import { MainNav } from "./main-nav"
import { ThemeToggle } from "@workspace/theme-toggle"
import { AppsMenu } from "./apps-menu"
import { UserInfo } from "./user-info"
import { CommandPalette } from "./command-palette"

export function TopNav() {
  return (
    <header className="sticky top-0 z-40 w-full border-b bg-background/80 backdrop-blur-sm">
      <div className=" flex h-16 items-center space-x-4 px-2 sm:justify-between sm:space-x-0">
        <MainNav/>
        <div className="flex flex-1 items-center justify-end space-x-4">
          <CommandPalette />
          <nav className="flex items-center space-x-1">
            <AppsMenu />
            <ThemeToggle />
            <UserInfo />
          </nav>
        </div>
      </div>
    </header>
  )
}
