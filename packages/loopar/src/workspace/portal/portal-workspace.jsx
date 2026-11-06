import BaseWorkspace from "@workspace/base/base-workspace";
import { useWorkspace } from "@workspace/workspace-provider";
import { Link } from "@link";
import { BaseIcon } from "@base-icons";
import { buttonVariants } from "@cn/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@cn/components/ui/dropdown-menu";
import { LogOutIcon, UserRoundCogIcon } from "lucide-react";
import { ThemeToggle } from "@workspace/theme-toggle";
import { Logo } from "../web/src/logo";

/** Kill the session and reload the current page (same pattern as the web nav). */
function handleLogout() {
  fetch("/auth/logout", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
    body: "{}",
  }).finally(() => window.location.reload());
}

function UserMenu() {
  const { user: me } = useWorkspace();
  if (!me) return null;

  const initial = (me.name || me.email || "?").trim().charAt(0).toUpperCase();
  const picture = me.profile_picture || me.profilePicture;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className={`${buttonVariants({ size: "icon", variant: "ghost" })} cursor-pointer rounded-full overflow-hidden`}
          aria-label="User menu"
        >
          {picture ? (
            <img src={picture} alt="" referrerPolicy="no-referrer" className="h-8 w-8 rounded-full object-cover" />
          ) : (
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/15 text-sm font-semibold">
              {initial}
            </span>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <div className="border-b px-3 py-2">
          <div className="truncate text-sm font-medium">{me.name}</div>
          {me.email ? <div className="truncate text-xs text-muted-foreground">{me.email}</div> : null}
        </div>
        <div className="grid grid-cols-1 p-1">
          <Link to="/portal/Profile/update" className="justify-start" variant="ghost" size="sm">
            <UserRoundCogIcon className="mr-2 h-4 w-4" /> Profile
          </Link>
          <button
            onClick={handleLogout}
            className={`${buttonVariants({ size: "sm", variant: "ghost" })} justify-start`}
          >
            <LogOutIcon className="mr-2 h-4 w-4" /> Log Out
          </button>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PortalNav({ menuData }) {
  const groups = menuData?.groups || [];
  const profile = menuData?.profile;

  return (
    <nav className="flex flex-col gap-4">
      {profile && (
        <Link to={profile.link} className="justify-start" variant="ghost" size="sm">
          <UserRoundCogIcon className="mr-2 h-4 w-4" /> {profile.label}
        </Link>
      )}
      {groups.map((group) => (
        <div key={group.name}>
          <h5 className="mb-1 px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {group.name}
          </h5>
          <ul className="flex flex-col gap-1">
            {(group.routes || []).map((route) => (
              <li key={route.link}>
                <Link to={route.link} className="justify-start" variant="ghost" size="sm">
                  {route.icon ? <BaseIcon icon={route.icon} className="mr-2 h-4 w-4" /> : null}
                  {route.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/**
 * Portal workspace — the end-user authenticated app. Renders the
 * permission-filtered menu (built server-side in WorkspaceController.portalMenuData),
 * a minimal top bar (brand + theme + user menu) and the active document.
 */
export default function PortalWorkspace(props) {
  const { ActiveView, __META__ } = useWorkspace();
  const menuData = props.menuData || {};
  const webApp = __META__?.web_app || {};
  const hasNav = (menuData.groups || []).length > 0;

  return (
    <BaseWorkspace webApp={webApp}>
      <div className="vaul-drawer-wrapper flex min-h-screen flex-col">
        <meta name="robots" content="noindex, nofollow" />

        <header className="sticky top-0 z-40 flex h-web-header-height items-center border-b bg-background/80 px-4 backdrop-blur-sm">
          {webApp.name ? (
            <Logo />
          ) : (
            <Link to="/" bare className="font-semibold">
              <img src="/assets/public/images/loopar.svg" alt="loopar" style={{ height: 24 }} />
            </Link>
          )}
          <div className="ml-auto flex items-center gap-1">
            <ThemeToggle />
            <UserMenu />
          </div>
        </header>

        <section className="flex flex-1">
          {hasNav && (
            <aside className="hidden w-64 shrink-0 border-r p-3 md:block">
              <PortalNav menuData={menuData} />
            </aside>
          )}

          <div className="flex-1 overflow-auto p-4">
            <div className="mx-auto w-full max-w-3xl">{ActiveView}</div>
          </div>
        </section>
      </div>
    </BaseWorkspace>
  );
}
