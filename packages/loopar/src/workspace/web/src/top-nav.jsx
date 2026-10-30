import { useState } from "react";
import { buttonVariants } from "@cn/components/ui/button";
import { cn } from "@cn/lib/utils";
import { Profile } from "./UserSecction.jsx";
import { Link } from "@link";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@cn/components/ui/dropdown-menu";
import { LogOutIcon, UserRoundCogIcon } from "lucide-react";
import { MainNav, MenuItems } from "./main-nav";
import { Logo } from "./logo";
import { ThemeToggle } from "@workspace/theme-toggle";
import { BaseIcon } from "@base-icons";
import { useWorkspace } from "@workspace/workspace-provider";
import { AnnouncementBar, useAnnouncementScroll } from "./announcement-bar";

function UserMenu({ onOpenLogin, onOpenProfile }) {
  // `user` is reactive (WorkspaceProvider refreshes it on `auth:changed`), so
  // the menu flips between Sign in / avatar after a modal login with no reload.
  const {user: me, __META__} = useWorkspace();
  const webApp = __META__.web_app;

  const handleLogout = () => {
    fetch("/auth/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
      body: "{}",
    }).finally(() => window.location.reload());
  };

  if(!webApp.show_user_section) return;

  if (!me) {
    return (
      <Link
        to="/auth/login"
        inModal
        className={`${buttonVariants({ size: "sm", variant: "ghost" })} hover:text-primary`}
      >
        Sign in
      </Link>
    );
  }

  const initial = (me.name || me.email || "?").trim().charAt(0).toUpperCase();
  const isWeb = me.user_type === "Web";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className={`${buttonVariants({ size: "icon", variant: "ghost" })} cursor-pointer rounded-full overflow-hidden`}
          aria-label="User menu"
        >
          {me.profilePicture ? (
            <img
              src={me.profilePicture}
              alt=""
              referrerPolicy="no-referrer"
              className="h-8 w-8 rounded-full object-cover"
            />
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
          {!isWeb && (
            <button
              onClick={onOpenProfile}
              className={`${buttonVariants({ size: "sm", variant: "ghost" })} justify-start`}
            >
              <UserRoundCogIcon className="mr-2 h-4 w-4" /> Profile
            </button>
          )}
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

function MenuActions({ menuActions = [], onOpenLogin, onOpenProfile }) {
  return (
    <nav className="flex items-center space-x-1">
      {menuActions.map((action, i) => {
        const classVariant = buttonVariants({
          size: "icon",
          variant: "ghost",
        }).replaceAll("text-primary", "");
        // Only other sites open in a new tab; site pages stay in this one.
        const external = /^(https?:)?\/\//i.test(action.action || "");
        const target = external ? { target: "_blank", rel: "noreferrer" } : {};
        const key = (action.action || "") + i;

        // With a button text: a button on wide screens, the icon on small ones.
        if (action.label) {
          return (
            <span key={key} className="contents">
              <a href={action.action} {...target} className={cn(buttonVariants({ size: "sm" }), "hidden lg:inline-flex mr-2")}>
                {action.label}
              </a>
              <a href={action.action} {...target} className="hover:text-primary lg:hidden" aria-label={action.label}>
                <div className={`${classVariant} hover:text-primary`}>
                  <BaseIcon icon={action.icon} className="h-5 w-5" />
                </div>
              </a>
            </span>
          );
        }

        return (
          <a
            key={key}
            href={action.action}
            {...target}
            className="hover:text-primary"
          >
            <div className={`${classVariant} hover:text-primary`}>
              <BaseIcon icon={action.icon} className="h-5 w-5" />
              <span className="sr-only">{action.action}</span>
            </div>
          </a>
        );
      })}
      <ThemeToggle />
      <UserMenu onOpenLogin={onOpenLogin} onOpenProfile={onOpenProfile} />
    </nav>
  );
}

export function TopNav({ menuActions, announcement = null, onCloseAnnouncement }) {
  const { webApp } = useWorkspace();
  const [updatingProfile, setUpdatingProfile] = useState(false);
  const logoPosition = ["left", "center", "right"].includes(webApp.logo_position)
    ? webApp.logo_position
    : "left";

  const actionProps = {
    menuActions,
    onOpenProfile: () => setUpdatingProfile(true),
  };

  // Past the top of the page the header slides up by the bar's height.
  const scrolled = useAnnouncementScroll(!!announcement);

  return (
    <header
      className="fixed top-0 z-40 w-full border-b bg-background/80 backdrop-blur-sm transition-transform duration-300"
      style={announcement && scrolled ? { transform: "translateY(calc(-1 * var(--web-announcement-height)))" } : undefined}
    >
      {announcement && <AnnouncementBar announcement={announcement} onClose={onCloseAnnouncement} />}
      {updatingProfile && <Profile onClose={() => setUpdatingProfile(false)} />}
      <div className="flex items-center px-2 h-web-header-height">
        <div className="flex lg:hidden flex-1 items-center">
          <MainNav />
          <div className="ml-auto flex items-center space-x-4">
            <MenuActions {...actionProps} />
          </div>
        </div>

        <div className="hidden lg:flex w-full items-center">

          {logoPosition === "left" && (
            <>
              <Logo variant="desktop" />
              <MenuItems className="ml-2" />
              <div className="ml-auto">
                <MenuActions {...actionProps} />
              </div>
            </>
          )}

          {logoPosition === "right" && (
            <>
              <MenuItems />
              <div className="ml-auto flex items-center space-x-4">
                <MenuActions {...actionProps} />
                <Logo variant="desktop" />
              </div>
            </>
          )}

          {logoPosition === "center" && (
            <div className="grid grid-cols-3 w-full items-center">
              <MenuItems half="first" className="justify-end" />
              <div className="flex items-center justify-center">
                <Logo variant="desktop" size="lg" />
              </div>
              <div className="flex items-center justify-between">
                <MenuItems half="second" />
                <MenuActions {...actionProps} />
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
