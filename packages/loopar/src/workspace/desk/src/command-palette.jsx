"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@cn/components/ui/command";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@cn/components/ui/dialog";
import {
  ComponentIcon, FileTextIcon, HistoryIcon, HouseIcon, LayoutDashboardIcon,
  ListIcon, Loader2Icon, PlusIcon, SearchIcon, Settings2Icon,
} from "lucide-react";
import { useWorkspace } from "@workspace/workspace-provider";
import loopar from "loopar";

const RECENT_KEY = "loopar-desk-command-recent";
const RECENT_MAX = 8;
const RESULTS_MAX = 50;
const RECORDS_MAX = 10;

const KIND_ICON = {
  list: ListIcon,
  new: PlusIcon,
  single: Settings2Icon,
  page: FileTextIcon,
  module: ComponentIcon,
  home: HouseIcon,
  dashboard: LayoutDashboardIcon,
  record: FileTextIcon,
  find: SearchIcon,
};

/** Bold part + muted part of each entry, as in "Customer List" / "New Customer". */
const labelOf = (item) => {
  switch (item.kind) {
    case "list": return { strong: item.entity, rest: "List" };
    case "new": return { lead: "New", strong: item.entity };
    case "module": return { strong: item.title, rest: "Module" };
    case "home": return { strong: item.title, rest: "Home" };
    case "dashboard": return { strong: item.title, rest: "Dashboard" };
    case "record": return { lead: item.entity, strong: item.title };
    case "find": return { lead: "Find", strong: item.title, rest: `in ${item.entity} list` };
    default: return { strong: item.entity };
  }
};

const textOf = (item) => {
  const { lead, strong, rest } = labelOf(item);
  return [lead, strong, rest].filter(Boolean).join(" ");
};

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
 * Score of an entry for a query: every token must appear in the label; a
 * label that starts with the query ranks first, then token at a word start.
 */
const score = (text, query, tokens) => {
  const t = text.toLowerCase();
  if (!tokens.every(tok => t.includes(tok))) return -1;
  if (t.startsWith(query)) return 3;
  if (tokens.every(tok => t.startsWith(tok) || t.includes(` ${tok}`))) return 2;
  return 1;
};

/** Every destination of the palette: modules/homes/dashboards from the menu + entities from the index. */
function useEntries() {
  const { __META__ } = useWorkspace();
  const menu = __META__?.menu_data;
  const index = __META__?.search_index;

  return useMemo(() => {
    const apps = Array.isArray(menu) ? menu : [];
    const appTitle = Object.fromEntries(apps.map(a => [a.name, a.description || a.name]));
    const entries = [];
    const seen = new Set();
    const push = (item) => {
      if (seen.has(item.link)) return;
      seen.add(item.link);
      entries.push({ ...item, appTitle: appTitle[item.app] || item.app || "" });
    };

    for (const app of apps) {
      if (app.home) push({ kind: "home", title: app.description || app.name, app: app.name, link: `/desk/${app.home}/view` });
      for (const m of app.modules || []) {
        if (m.link) push({ kind: "module", title: m.description || m.link, app: app.name, link: `/desk/${m.link}` });
      }
      for (const d of app.dashboards || []) {
        push({ kind: "dashboard", title: d.name, app: app.name, link: `/desk/Dashboard/view?name=${encodeURIComponent(d.name)}` });
      }
    }
    for (const item of Array.isArray(index) ? index : []) push(item);

    return entries.map(e => ({ ...e, text: textOf(e) }));
  }, [menu, index]);
}

/**
 * "<entity> <term>" searches records of that entity (longest entity name that
 * prefixes the query) through the entity's own `search` action, which already
 * applies the user's permissions and owner scope.
 */
function useRecordSearch(query, entries) {
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(false);
  const abortRef = useRef(null);

  const target = useMemo(() => {
    const q = query.toLowerCase();
    let best = null;
    for (const e of entries) {
      if (e.kind !== "list") continue;
      const name = e.entity.toLowerCase();
      if (q.startsWith(`${name} `) && (!best || name.length > best.entity.length)) best = e;
    }
    if (!best) return null;
    const term = query.slice(best.entity.length).trim();
    return term ? { entity: best.entity, app: best.app, appTitle: best.appTitle, term } : null;
  }, [query, entries]);

  useEffect(() => {
    abortRef.current?.abort();
    if (!target) {
      setRecords([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    const controller = new AbortController();
    abortRef.current = controller;

    const timer = setTimeout(() => {
      loopar.call(target.entity, "search", {
        query: { q: target.term, page: 1, limit: RECORDS_MAX },
        signal: controller.signal,
        freeze: false,
        notifyError: false,
        success: (r) => {
          if (controller.signal.aborted) return;
          const titleFields = (r?.title_fields || []).filter(f => f !== "name");
          setRecords((r?.rows || []).slice(0, RECORDS_MAX).map(row => {
            const title = titleFields.map(f => row[f]).filter(Boolean).join(" - ");
            const item = {
              kind: "record",
              entity: target.entity,
              app: target.app,
              appTitle: target.appTitle,
              title: title && title !== row.name ? `${row.name} · ${title}` : row.name,
              link: `/desk/${target.entity}/update?name=${encodeURIComponent(row.name)}`,
            };
            return { ...item, text: textOf(item) };
          }));
          setLoading(false);
        },
        error: () => {
          if (controller.signal.aborted) return;
          setRecords([]);
          setLoading(false);
        },
      });
    }, 250);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [target?.entity, target?.term]);

  return { records, loading, target };
}

/** The entity's list filtered by the term (list state lives in the URL). */
const findInList = (target) => {
  const item = {
    kind: "find",
    entity: target.entity,
    app: target.app,
    appTitle: target.appTitle,
    title: target.term,
    link: `/desk/${target.entity}/list?name=${encodeURIComponent(target.term)}`,
  };
  return { ...item, text: textOf(item) };
};

function Entry({ item, onSelect }) {
  const Icon = KIND_ICON[item.kind] || FileTextIcon;
  const { lead, strong, rest } = labelOf(item);

  return (
    <CommandItem value={item.link} onSelect={() => onSelect(item)} className="gap-3">
      <Icon className="shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">
        {lead && <span>{lead} </span>}
        <span className="font-semibold">{strong}</span>
        {rest && <span> {rest}</span>}
      </span>
      {item.appTitle && <span className="shrink-0 text-xs text-muted-foreground">{item.appTitle}</span>}
    </CommandItem>
  );
}

const Kbd = ({ children }) => (
  <kbd className="pointer-events-none inline-flex h-5 shrink-0 items-center gap-0.5 rounded border bg-background px-1.5 font-mono text-[10px] font-medium text-muted-foreground">{children}</kbd>
);

/** Desk command palette (Ctrl/Cmd+K): jump to any list, form, page, module or record. */
export function CommandPalette() {
  const { navigate } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [recent, setRecent] = useState([]);
  // Rendered as "Ctrl" on the server; corrected after mount to avoid a hydration mismatch.
  const [modKey, setModKey] = useState("Ctrl");
  const entries = useEntries();
  const { records, loading, target } = useRecordSearch(query.trim(), entries);

  useEffect(() => {
    if (/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)) setModKey("⌘");
  }, []);

  useEffect(() => {
    const onKeyDown = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(o => !o);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (open) setRecent(readRecent());
    else setQuery("");
  }, [open]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const tokens = q.split(/\s+/).filter(Boolean);
    return entries
      .map(e => ({ e, s: score(e.text, q, tokens) }))
      .filter(x => x.s >= 0)
      .sort((a, b) => b.s - a.s || a.e.text.length - b.e.text.length)
      .slice(0, RESULTS_MAX)
      .map(x => x.e);
  }, [query, entries]);

  const select = useCallback((item) => {
    const { text, ...stored } = item;
    const next = [stored, ...readRecent().filter(r => r.link !== item.link)].slice(0, RECENT_MAX);
    writeRecent(next);
    setOpen(false);
    navigate(item.link);
  }, [navigate]);

  const recentItems = recent.map(r => ({ ...r, text: textOf(r) }));
  const empty = !query.trim();

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="hidden h-9 w-56 shrink-0 items-center gap-2 whitespace-nowrap rounded-md border bg-muted/40 px-3 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:flex"
      >
        <SearchIcon className="h-4 w-4 shrink-0" />
        <span className="flex-1 truncate text-left">Search…</span>
        <Kbd>{modKey}K</Kbd>
      </button>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-9 w-9 items-center justify-center rounded-md hover:bg-muted md:hidden"
        aria-label="Search"
      >
        <SearchIcon className="h-5 w-5" />
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl overflow-hidden p-0 shadow-lg">
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <DialogDescription className="sr-only">Search lists, forms, pages, modules and records</DialogDescription>
        <Command
          shouldFilter={false}
          className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group]]:px-2 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-2.5 [&_[cmdk-item]_svg]:h-4 [&_[cmdk-item]_svg]:w-4"
        >
        <CommandInput value={query} onValueChange={setQuery} placeholder="Search lists, pages, modules or records…" />
        <CommandList className="max-h-[60vh]">
          {!empty && !loading && !results.length && !records.length && (
            <CommandEmpty>No results found.</CommandEmpty>
          )}

          {empty && recentItems.length > 0 && (
            <CommandGroup heading={<span className="flex items-center gap-1"><HistoryIcon className="h-3 w-3" />Recent</span>}>
              {recentItems.map(item => <Entry key={item.link} item={item} onSelect={select} />)}
            </CommandGroup>
          )}
          {empty && !recentItems.length && (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">
              Type an entity, page or module. Use "<span className="font-medium">Entity term</span>" to find records.
            </div>
          )}

          {target && (
            <CommandGroup heading={`${target.entity} records`}>
              {loading && (
                <div className="flex items-center gap-2 px-2 py-3 text-sm text-muted-foreground">
                  <Loader2Icon className="h-4 w-4 animate-spin" /> Searching…
                </div>
              )}
              {!loading && !records.length && (
                <div className="px-2 py-3 text-sm text-muted-foreground">No {target.entity} matches "{target.term}".</div>
              )}
              {records.map(item => <Entry key={item.link} item={item} onSelect={select} />)}
              {!loading && <Entry item={findInList(target)} onSelect={select} />}
            </CommandGroup>
          )}

          {results.length > 0 && (
            <CommandGroup heading={target ? "Go to" : undefined}>
              {results.map(item => <Entry key={item.link} item={item} onSelect={select} />)}
            </CommandGroup>
          )}
        </CommandList>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t px-3 py-2 text-xs text-muted-foreground">
          <span className="flex items-center gap-1"><Kbd>↑</Kbd><Kbd>↓</Kbd> to navigate</span>
          <span className="flex items-center gap-1"><Kbd>↵</Kbd> to select</span>
          <span className="flex items-center gap-1"><Kbd>Esc</Kbd> to close</span>
        </div>
        </Command>
        </DialogContent>
      </Dialog>
    </>
  );
}
