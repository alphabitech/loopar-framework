"use client"

import { SideNavItem } from "./side-nav-item";
import { useWorkspace } from "@workspace/workspace-provider";
import { ChevronLeftIcon, ChevronsUpDownIcon, HouseIcon, LayoutDashboardIcon, LayoutGridIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation } from "react-router";
import { usePersist } from "@services/persist-state";
import { Popover, PopoverTrigger, PopoverContent } from "@cn/components/ui/popover";
import { cn } from "@cn/lib/utils";
import { Link } from "@link";
import Icon from "@icon";
import { MainNav } from "./main-nav";
import { __ } from "@global/i18n";

const appOwns = (app, key) =>
  !!key && (app.home === key || (app.modules || []).some(m => m.link === key || (m.submodules || []).includes(key) || (m.routes || []).some(r => r.description === key)));

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

/** Short name for the rail label: the app's name, humanized ("my_app" → "My app"). */
const appLabel = (app) => {
  const s = String(app.name || "").replace(/[-_]+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
};

function AppIcon({ app, className }) {
  return app.icon
    ? <Icon data={{ icon: app.icon }} className={className} />
    : <LayoutGridIcon className={className} />;
}

/** Rail: icon + short label under it (Teams/Discord pattern), full description on hover. */
function AppRail({ apps, activeApp }) {
  return (
    <nav aria-label={__("Apps")} className="flex w-[72px] shrink-0 flex-col items-center border-r border-border/60">
      <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-y-auto pb-3">
      <LogoMark />
      {apps.map(app => {
        const active = app.name === activeApp?.name;
        return (
          <Link
            key={app.name}
            award={false}
            bare
            to={appHome(app)}
            title={__(app.description)}
            aria-current={active ? "page" : undefined}
            className={cn(
              "group flex w-16 flex-col items-center gap-1 rounded-lg py-1.5 transition-colors",
              active ? "text-foreground" : "text-muted-foreground hover:text-foreground"
            )}
          >
            <span
              className={cn(
                "flex h-9 w-9 items-center justify-center rounded-lg transition-colors",
                active ? "bg-primary text-primary-foreground" : "group-hover:bg-secondary/60"
              )}
            >
              <AppIcon app={app} className="h-5 w-5" />
            </span>
            <span className={cn("w-full truncate px-0.5 text-center text-[10px] leading-tight", active && "font-semibold")}>
              {__(appLabel(app))}
            </span>
          </Link>
        );
      })}
      </div>
    </nav>
  );
}

/** Brand mark heading the rail (Slack/Discord: workspace icon on top). */
function LogoMark() {
  return (
    <Link award={false} bare to="/desk" title={__("Desk")} className="mb-1 flex h-header-height w-full shrink-0 items-center justify-center">
      <img src="/assets/public/images/logo-dark-min.svg" alt={__("Loopar")} className="h-7 w-8" loading="lazy" decoding="async" />
    </Link>
  );
}

/** First row of the module panel, same height as the content header:
 *  the app selector plus the sidebar toggle. */
function PanelTop({ children }) {
  return (
    <div className="flex h-header-height shrink-0 items-center gap-1">
      <div className="min-w-0 flex-1">{children}</div>
      <MainNav logo={false} />
    </div>
  );
}

/** App list shared by the header selector and the collapsed switcher. */
function AppMenuItems({ apps, activeApp, detailed }) {
  return apps.map(app => (
    <Link
      key={app.name}
      award={false}
      bare
      to={appHome(app)}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm",
        app.name === activeApp?.name ? "bg-secondary font-medium" : "hover:bg-secondary/60"
      )}
    >
      <AppIcon app={app} className="h-4 w-4 shrink-0" />
      {detailed ? (
        <span className="flex min-w-0 flex-col">
          <span className="truncate">{__(appLabel(app))}</span>
          {app.description && app.description !== app.name && (
            <span className="truncate text-xs font-normal text-muted-foreground">{__(app.description)}</span>
          )}
        </span>
      ) : (
        <span className="truncate">{__(app.description)}</span>
      )}
    </Link>
  ));
}

/** Closes a popover on navigation (Link takes no onClick without turning into a <button>). */
function useCloseOnNavigate() {
  const [open, setOpen] = useState(false);
  const { pathname, search } = useLocation();
  useEffect(() => setOpen(false), [pathname, search]);
  return [open, setOpen];
}

/** Panel title doubles as an app selector (Slack/Notion workspace switcher pattern). */
function AppHeader({ apps, activeApp, multiApp }) {
  const [open, setOpen] = useCloseOnNavigate();
  const title = (
    <span className="min-w-0 flex-1 truncate text-left font-semibold text-slate-900 dark:text-slate-200">
      {__(activeApp.description)}
    </span>
  );

  if (!multiApp) return <h5 className="flex px-1">{title}</h5>;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={__(activeApp.description)}
          className="flex w-full items-center gap-1 rounded-md px-1 py-1 hover:bg-secondary/60"
        >
          {title}
          <ChevronsUpDownIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="max-h-[70vh] w-72 overflow-y-auto p-1">
        <AppMenuItems apps={apps} activeApp={activeApp} detailed />
      </PopoverContent>
    </Popover>
  );
}

/** Collapsed sidebar: no room for the rail, the active app opens a switcher. */
function AppSwitcher({ apps, activeApp }) {
  const [open, setOpen] = useCloseOnNavigate();

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={__(activeApp.description)}
          className="mx-auto mt-1 flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-primary-foreground"
        >
          <AppIcon app={activeApp} className="h-5 w-5" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="right" align="start" className="max-h-[70vh] w-64 overflow-y-auto p-1">
        <AppMenuItems apps={apps} activeApp={activeApp} detailed />
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
        {compact ? <small className="w-full truncate">{__("Home")}</small> : <span className="min-w-0 flex-1">{__("Home")}</span>}
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
          submodules={module.submodules}
          title={__(module.description)}
          compact={compact}
          className="rounded-md py-2 hover:bg-slate-300/50 dark:hover:bg-slate-700/80"
        />
      ))}
      {(app?.dashboards || []).length > 0 && !compact && (
        <li className="mt-4 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{__("Dashboards")}</li>
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
      // Ctrl/Cmd+K belongs to the command palette; Ctrl/Cmd+B toggles the sidebar.
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toogleSidebarNav();
      }
      if (e.key === "Escape") setOpenNav();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toogleSidebarNav, setOpenNav]);

  return (
    <div
      className={`fixed inset-0 z-50 overflow-hidden duration-100 ease-in bg-popover/90 lg:bg-transparent border-r ${openNav ? '!w-sidebar-width lg:!w-sidebar-width' : 'w-0 lg:!w-collapse-sidebar-width'}`}
    >
      <div
        className={`fixed inset-0 backdrop-blur-sm ${!openNav && "hidden"} lg:hidden`}
        aria-hidden="true"
        data-headlessui-state
        onClick={() => setOpenNav(false)}
      />
      <div className="relative flex h-dvh w-full flex-col bg-background lg:bg-transparent">
        <div className="relative flex min-h-0 flex-1 flex-col lg:text-sm lg:leading-6">
          <div className="flex min-h-0 flex-1">
            {openNav ? (
              <>
                {multiApp && <AppRail apps={apps} activeApp={activeApp} />}
                <div className="flex min-w-0 flex-1 flex-col overflow-auto px-2">
                  <PanelTop>
                    {activeApp && <AppHeader apps={apps} activeApp={activeApp} multiApp={multiApp} />}
                  </PanelTop>
                  <ModuleList app={activeApp} />
                </div>
              </>
            ) : (
              <div className="flex w-full flex-col items-stretch overflow-auto">
                <div className="flex h-header-height shrink-0 items-center justify-center">
                  <MainNav logo={false} />
                </div>
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
