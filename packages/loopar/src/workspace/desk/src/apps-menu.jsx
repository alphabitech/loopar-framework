import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@cn/components/ui/dropdown-menu";
import { Link } from "@link";
import Icon from "@icon";
import { cn } from "@cn/lib/utils";
import { buttonVariants } from "@cn/components/ui/button";
import { HistoryIcon, LayoutGridIcon, PinIcon, PinOffIcon, XIcon } from "lucide-react";
import { useWorkspace } from "@workspace/workspace-provider";
import loopar from "loopar";
import { __ } from "@global/i18n";

const RECENT_KEY = "loopar-desk-recent-pages";
const RECENT_MAX = 8;
const RECENT_SHOWN = 6;
const APP_HOME = "App Home";

/** Shown until the user pins or unpins something (then their own list is saved). */
const DEFAULT_PINS = [
  { label: "Entities", link: "/desk/Entity/list", icon: "Brush" },
  { label: "Builders", link: "/desk/Builder/list", icon: "Cog" },
  { label: "Apps", link: "/desk/App Manager/view", icon: "CircuitBoard" },
  { label: "Modules", link: "/desk/Module/list", icon: "Component" },
  { label: "Settings", link: "/desk/System Settings/update", icon: "Settings2" },
  { label: "Files", link: "/desk/File Manager/list", icon: "Files" },
  { label: "Users", link: "/desk/User/list", icon: "User" },
  { label: "Auth Manager", link: "/desk/Role Permission Manager/view", icon: "LockKeyhole" },
  { label: "Analytics", link: "/desk/Analytics Dashboard/view", icon: "ChartSpline" },
  { label: "Backups", link: "/desk/Backups/view", icon: "DatabaseBackup" },
];

const sameLink = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();

const readRecent = () => {
  try {
    const value = JSON.parse(window.localStorage.getItem(RECENT_KEY) || "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
};

const writeRecent = (items) => {
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(items));
  } catch {
    // Storage unavailable (private mode, blocked): recents are a convenience.
  }
};

/**
 * Every place of the desk the user reaches, by link: modules, app homes,
 * dashboards and documents (desk menu + command palette index), each with
 * the label and icon a pin or a recent entry shows.
 */
function useDestinations() {
  const { __META__ } = useWorkspace();
  const menu = __META__?.menu_data;
  const index = __META__?.search_index;

  return useMemo(() => {
    const byLink = new Map();
    const put = (link, label, icon) => {
      const key = String(link).toLowerCase();
      if (!byLink.has(key)) byLink.set(key, { link, label, icon: icon || null });
    };

    for (const app of Array.isArray(menu) ? menu : []) {
      const home = app.home
        ? `/desk/${app.home}/view`
        : `/desk/${APP_HOME}/view?app=${encodeURIComponent(app.name)}`;
      put(home, app.description || app.name, app.icon);
      for (const m of app.modules || []) {
        if (m.link) put(`/desk/${m.link}`, m.description || m.link, m.icon);
        for (const doc of [...(m.docs || []), ...(m.sections || []).flatMap(s => s.docs)]) put(doc.link, doc.name, m.icon);
      }
      for (const d of app.dashboards || []) {
        put(`/desk/Dashboard/view?name=${encodeURIComponent(d.name)}`, d.name, "LayoutDashboard");
      }
    }
    for (const item of Array.isArray(index) ? index : []) {
      if (item.kind !== "new") put(item.link, item.entity, null);
    }
    return byLink;
  }, [menu, index]);
}

/** The page being shown as a destination (link + label + icon), or null (records, unknown routes). */
function useCurrentDestination(destinations) {
  const { pathname, search } = useLocation();

  return useMemo(() => {
    const [, workspace, rawDoc, action] = pathname.split("/");
    if (workspace !== "desk" || !rawDoc) return null;
    const doc = decodeURIComponent(rawDoc);
    const query = new URLSearchParams(search);

    // Only the query that names the page itself (an app's home, a dashboard); a `name` elsewhere is a record.
    let link;
    if (doc === APP_HOME) link = `/desk/${APP_HOME}/view?app=${encodeURIComponent(query.get("app") || "")}`;
    else if (doc === "Dashboard") link = `/desk/Dashboard/view?name=${encodeURIComponent(query.get("name") || "")}`;
    else if (query.get("name")) return null;
    else link = action ? `/desk/${doc}/${action}` : `/desk/${doc}`;

    return destinations.get(link.toLowerCase()) || null;
  }, [pathname, search, destinations]);
}

function Tile({ pin, onUnpin }) {
  return (
    <div className="group relative">
      <Link
        award={false}
        bare
        to={pin.link}
        title={__(pin.label)}
        className="flex h-full flex-col items-center gap-1.5 rounded-lg p-2 text-center text-xs text-foreground transition-colors hover:bg-secondary/60 hover:text-foreground"
      >
        <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
          {pin.icon ? <Icon data={{ icon: pin.icon }} className="h-5 w-5" /> : <LayoutGridIcon className="h-5 w-5" />}
        </span>
        <span className="line-clamp-2 w-full break-words leading-tight">{__(pin.label)}</span>
      </Link>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onUnpin(pin); }}
        title={__("Unpin")}
        aria-label={__("Unpin {0}", [__(pin.label)])}
        className="absolute right-0.5 top-0.5 hidden h-5 w-5 items-center justify-center rounded-full bg-muted text-muted-foreground hover:text-foreground group-hover:flex"
      >
        <XIcon className="h-3 w-3" />
      </button>
    </div>
  );
}

/**
 * Top bar shortcuts (grid icon): the pages the user pinned plus the ones they
 * visited last. Pins are saved per user (Desk Pin); recents stay in this
 * browser. Until the user pins anything the menu offers the system's usual
 * places, limited to the ones they can open.
 */
export function AppsMenu() {
  const { __META__ } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(() => __META__?.desk_pins ?? null);
  const [recent, setRecent] = useState([]);
  const destinations = useDestinations();
  const current = useCurrentDestination(destinations);

  const pins = useMemo(() => saved ?? DEFAULT_PINS.filter(p => destinations.has(p.link.toLowerCase())), [saved, destinations]);
  const isPinned = !!current && pins.some(p => sameLink(p.link, current.link));

  // Every page the user opens becomes their most recent one.
  useEffect(() => {
    if (!current) return;
    writeRecent([current, ...readRecent().filter(r => !sameLink(r.link, current.link))].slice(0, RECENT_MAX));
  }, [current?.link]);

  useEffect(() => {
    if (open) setRecent(readRecent());
  }, [open]);

  const save = useCallback(async (next) => {
    setSaved(next);
    try {
      const res = await loopar.call("Desk Pin", "save", { body: { pins: next }, freeze: false, notifyError: false });
      if (Array.isArray(res?.pins)) setSaved(res.pins);
    } catch (e) {
      // Not saved (e.g. the app is not updated yet): the change still applies until reload.
      console.warn("[desk] pins not saved:", e?.message || e);
    }
  }, []);

  const togglePin = () => {
    if (!current) return;
    save(isPinned ? pins.filter(p => !sameLink(p.link, current.link)) : [...pins, current]);
  };
  const unpin = (pin) => save(pins.filter(p => !sameLink(p.link, pin.link)));

  // Recents still reachable, not already pinned.
  const recentShown = recent
    .filter(r => destinations.has(String(r.link).toLowerCase()) && !pins.some(p => sameLink(p.link, r.link)))
    .slice(0, RECENT_SHOWN);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title={__("Shortcuts")}
          className={cn(buttonVariants({ size: "icon", variant: "ghost" }), "cursor-pointer")}
        >
          <LayoutGridIcon />
          <span className="sr-only">{__("Shortcuts")}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 bg-card p-2">
        <div className="flex items-center justify-between gap-2 px-1 pb-1">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{__("Pinned")}</span>
          {current && (
            <button
              type="button"
              onClick={togglePin}
              className="flex min-w-0 items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
              title={isPinned ? __("Unpin {0}", [__(current.label)]) : __("Pin {0}", [__(current.label)])}
            >
              {isPinned ? <PinOffIcon className="h-3.5 w-3.5 shrink-0" /> : <PinIcon className="h-3.5 w-3.5 shrink-0" />}
              <span className="truncate">{isPinned ? __("Unpin this page") : __("Pin this page")}</span>
            </button>
          )}
        </div>

        <div onClick={() => setOpen(false)}>
          {pins.length
            ? (
              <div className="grid grid-cols-3 gap-1">
                {pins.map(pin => <Tile key={pin.link} pin={pin} onUnpin={unpin} />)}
              </div>
            )
            : <p className="px-2 py-3 text-sm text-muted-foreground">{__("Nothing pinned yet. Open a page and pin it from here.")}</p>}

          {recentShown.length > 0 && (
            <>
              <div className="mx-1 my-2 border-t" />
              <div className="flex items-center gap-1 px-1 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <HistoryIcon className="h-3 w-3" />{__("Recent")}
              </div>
              <div className="flex flex-col">
                {recentShown.map(r => (
                  <Link
                    key={r.link}
                    award={false}
                    bare
                    to={r.link}
                    className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground hover:bg-secondary/60 hover:text-foreground"
                  >
                    {r.icon ? <Icon data={{ icon: r.icon }} className="h-4 w-4 shrink-0 text-muted-foreground" /> : <LayoutGridIcon className="h-4 w-4 shrink-0 text-muted-foreground" />}
                    <span className="min-w-0 flex-1 truncate">{__(r.label)}</span>
                  </Link>
                ))}
              </div>
            </>
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
