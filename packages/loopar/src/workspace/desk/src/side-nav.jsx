"use client"

import { SideNavItem } from "./side-nav-item";
import { useWorkspace } from "@workspace/workspace-provider";
import { ChevronLeftIcon, HouseIcon, LayoutDashboardIcon, LayoutGridIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation } from "react-router";
import { usePersist } from "@services/persist-state";
import { Popover, PopoverTrigger, PopoverContent } from "@cn/components/ui/popover";
import { cn } from "@cn/lib/utils";
import { Link } from "@link";
import Icon from "@icon";

const appOwns = (app, key) =>
  !!key && (app.home === key || (app.modules || []).some(m => m.link === key || (m.routes || []).some(r => r.description === key)));

const homePath = (app) => `/desk/${app.home}/view`;

/** The app's entry point: its home Desk Page, else its first module. */
const appHome = (app) => app.home ? homePath(app) : `/desk/${app.modules?.[0]?.link || ""}`;

/**
 * Active app = the one owning the current route (module page or any entity in
 * its modules). Routes owned by no app (Profile, Desk home…) keep the last
 * active one, persisted per user.
 */
function useActiveApp(apps) {
  const { activeModule } = useWorkspace();
  const { pathname, search } = useLocation();
  const [stored, setStored] = usePersist("desk-active-app", null);

  const segment = decodeURIComponent(pathname.split("/")[2] || "");
  const dashboard = segment === "Dashboard" ? new URLSearchParams(search).get("name") : null;
  const fromRoute = (dashboard && apps.find(a => (a.dashboards || []).some(d => d.name === dashboard)))
    || apps.find(a => appOwns(a, activeModule)) || apps.find(a => appOwns(a, segment));

  useEffect(() => {
    if (fromRoute && fromRoute.name !== stored) setStored(fromRoute.name);
  }, [fromRoute?.name]);

  return fromRoute || apps.find(a => a.name === stored) || apps[0];
}

function AppIcon({ app, className }) {
  return app.icon
    ? <Icon data={{ icon: app.icon }} className={className} />
    : <LayoutGridIcon className={className} />;
}

function AppRail({ apps, activeApp }) {
  return (
    <nav aria-label="Apps" className="flex w-14 shrink-0 flex-col items-center gap-2 border-r border-border/60 py-3">
      {apps.map(app => {
        const active = app.name === activeApp?.name;
        return (
          <Link
            key={app.name}
            award={false}
            bare
            to={appHome(app)}
            title={app.description}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex h-10 w-10 items-center justify-center rounded-lg transition-colors",
              active
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
            )}
          >
            <AppIcon app={app} className="h-5 w-5" />
          </Link>
        );
      })}
    </nav>
  );
}

/** Collapsed sidebar: no room for the rail, the active app opens a switcher. */
function AppSwitcher({ apps, activeApp }) {
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();

  // Link takes no onClick without turning into a <button>: close on navigation.
  useEffect(() => setOpen(false), [pathname]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={activeApp.description}
          className="mx-auto mt-3 flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-primary-foreground"
        >
          <AppIcon app={activeApp} className="h-5 w-5" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="right" align="start" className="w-56 p-1">
        {apps.map(app => (
          <Link
            key={app.name}
            award={false}
            bare
            to={appHome(app)}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm",
              app.name === activeApp.name ? "bg-secondary font-medium" : "hover:bg-secondary/60"
            )}
          >
            <AppIcon app={app} className="h-4 w-4" />
            <span className="truncate">{app.description}</span>
          </Link>
        ))}
      </PopoverContent>
    </Popover>
  );
}

/** The app's home page, first entry of its module list. */
function HomeItem({ app, compact }) {
  const { pathname } = useLocation();
  const active = decodeURIComponent(pathname.split("/")[2] || "") === app.home;

  return (
    <li>
      <Link
        award={false}
        to={homePath(app)}
        active={active}
        className={cn(
          "flex w-full rounded-md py-2 hover:bg-slate-300/50 dark:hover:bg-slate-700/80",
          compact ? "h-auto flex-col items-center text-center" : "justify-start text-left"
        )}
      >
        <HouseIcon className={compact ? "h-6 w-8 shrink-0" : "mr-2 h-6 w-6 shrink-0"} />
        {compact ? <small className="w-full truncate">Home</small> : <span className="min-w-0 flex-1">Home</span>}
      </Link>
    </li>
  );
}

/** A dashboard pinned to the app's sidebar (Dashboard: app + "Show in sidebar"). */
function DashboardItem({ dashboard, compact }) {
  const { pathname, search } = useLocation();
  const active = decodeURIComponent(pathname.split("/")[2] || "") === "Dashboard"
    && new URLSearchParams(search).get("name") === dashboard.name;

  return (
    <li>
      <Link
        award={false}
        to={`/desk/Dashboard/view?name=${encodeURIComponent(dashboard.name)}`}
        active={active}
        title={dashboard.description || dashboard.name}
        className={cn(
          "flex w-full rounded-md py-2 hover:bg-slate-300/50 dark:hover:bg-slate-700/80",
          compact ? "h-auto flex-col items-center text-center" : "justify-start text-left"
        )}
      >
        <LayoutDashboardIcon className={compact ? "h-6 w-8 shrink-0" : "mr-2 h-6 w-6 shrink-0"} />
        {compact
          ? <small className="w-full truncate">{dashboard.name}</small>
          : <span className="min-w-0 flex-1 truncate">{dashboard.name}</span>}
      </Link>
    </li>
  );
}

function ModuleList({ app, compact }) {
  return (
    <ul className={cn("flex flex-col gap-1", compact ? "mt-3 px-1" : "px-1")}>
      {app?.home && <HomeItem app={app} compact={compact} />}
      {(app?.modules || []).map((module, key) => (
        <SideNavItem
          key={module.link ?? module.description ?? key}
          active={!!module.link}
          disabled={module.disabled}
          external={module.external}
          icon={module.icon}
          DefaultIcon={ChevronLeftIcon}
          path={module.link}
          title={module.description}
          compact={compact}
          className="rounded-md py-2 hover:bg-slate-300/50 dark:hover:bg-slate-700/80"
        />
      ))}
      {(app?.dashboards || []).length > 0 && !compact && (
        <li className="mt-4 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Dashboards</li>
      )}
      {(app?.dashboards || []).map(d => <DashboardItem key={d.name} dashboard={d} compact={compact} />)}
    </ul>
  );
}

/**
 * Desk sidebar: apps (rail) → modules of the active app. With a single
 * reachable app the rail is omitted and only its modules are listed.
 */
export function SideNav({ items = [] }) {
  const { openNav, setOpenNav, toogleSidebarNav } = useWorkspace();
  const apps = items.filter(app => app.modules?.length);
  const activeApp = useActiveApp(apps);
  const multiApp = apps.length > 1;

  useEffect(() => {
    if (typeof window === "undefined") return;

    const onKeyDown = (e) => {
      if (e.ctrlKey && e.key === "k") toogleSidebarNav();
      if (e.key === "Escape") setOpenNav();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toogleSidebarNav, setOpenNav]);

  return (
    <div
      className={`fixed inset-0 z-50 duration-100 ease-in bg-popover/90 lg:bg-transparent border-r lg:!top-header-height ${openNav ? '!w-sidebar-width lg:!w-sidebar-width' : 'w-0 lg:!w-collapse-sidebar-width'}`}
    >
      <div
        className={`fixed inset-0 backdrop-blur-sm ${!openNav && "hidden"} lg:hidden`}
        aria-hidden="true"
        data-headlessui-state
        onClick={() => setOpenNav(false)}
      />
      <div className="w-full">
        {openNav && <button
          type="button"
          className="absolute right-5 top-1 z-10 flex h-8 w-8 items-center justify-center text-slate-500 hover:text-slate-600 dark:text-slate-400 dark:hover:text-slate-300 lg:hidden"
          tabIndex={0}
          onClick={() => setOpenNav(false)}
        >
          <span className="sr-only">Close navigation</span>
          <svg viewBox="0 0 10 10" className="h-2.5 w-2.5 overflow-visible">
            <path d="M0 0L10 10M10 0L0 10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"></path>
          </svg>
        </button>}
        <div className="relative lg:text-sm lg:leading-6">
          <div className={`flex h-[calc(100vh-theme('spacing.header-height'))] border-t-2 border-t-slate-200/10`}>
            {openNav ? (
              <>
                {multiApp && <AppRail apps={apps} activeApp={activeApp} />}
                <div className="flex min-w-0 flex-1 flex-col overflow-auto px-2">
                  {activeApp && (
                    <h5 className="mb-1 mt-3 truncate px-1 font-semibold text-slate-900 dark:text-slate-200">
                      {activeApp.description}
                    </h5>
                  )}
                  <ModuleList app={activeApp} />
                </div>
              </>
            ) : (
              <div className="flex w-full flex-col overflow-auto">
                {multiApp && activeApp && <AppSwitcher apps={apps} activeApp={activeApp} />}
                <ModuleList app={activeApp} compact />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
