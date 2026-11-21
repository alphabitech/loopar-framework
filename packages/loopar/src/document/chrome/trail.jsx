import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation } from "react-router";
import { ChevronRightIcon } from "lucide-react";
import { Link } from "@link";
import { cn } from "@cn/lib/utils";
import { useDocument } from "@loopar/document";
import { useWorkspace } from "@workspace/workspace-provider";
import { __ } from "@global/i18n";

/*
 * Desk trail (breadcrumbs): app › module › … — shown in the desk top bar
 * (#desk-trail, workspace/desk/src/top-nav.jsx), above the title on phones.
 * Light on purpose: pages (also served on websites) import it.
 */

const APP_HOME = "App Home";

/** The app's entry point: its home Desk Page, else the generic App Home (same as the desk sidebar). */
const appHomePath = (app) => app.home
  ? `/desk/${app.home}/view`
  : `/desk/${APP_HOME}/view?app=${encodeURIComponent(app.name)}`;

/** "my_module" → "My module": submodules come by name. */
const humanize = (name) => {
  const s = String(name || "").replace(/[-_]+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
};

/** The app and menu module owning a module name (a submodule hangs from its parent). */
function findModule(apps, moduleName) {
  if (!moduleName) return {};
  for (const app of apps) {
    for (const module of app.modules || []) {
      if (module.link === moduleName) return { app, module };
      if ((module.submodules || []).includes(moduleName)) return { app, module, sub: moduleName };
    }
  }
  return {};
}

/** Short app name for the trail: its description when short, else the rail label (name). */
const appCrumbLabel = (app) => {
  const description = __(app.description || "");
  return description && description.length <= 24 ? description : humanize(app.name);
};

const appCrumb = (app) => ({ app: true, label: appCrumbLabel(app), title: __(app.description || humanize(app.name)), to: appHomePath(app) });

/**
 * An app's home — its own Desk Page, or the generic App Home (`?app=`) —
 * sits right under the app: app › Home. Null for any other document.
 */
export function homeCrumbs(apps, Document, search = "") {
  const name = Document?.Entity?.name;
  if (!name) return null;
  const fromQuery = name === APP_HOME ? new URLSearchParams(search).get("app") : null;
  const app = (fromQuery && apps.find((a) => a.name === fromQuery)) || apps.find((a) => a.home === name);
  return app ? [appCrumb(app), { label: __("Home"), to: appHomePath(app) }] : null;
}

export const moduleCrumbs = (apps, moduleName, { self = true } = {}) => {
  const { app, module, sub } = findModule(apps, moduleName);
  const crumbs = [];
  if (app) crumbs.push(appCrumb(app));
  if (module) {
    if (sub) {
      crumbs.push({ label: __(module.description || humanize(module.link)), to: `/desk/${encodeURIComponent(module.link)}` });
      if (self) crumbs.push({ label: __(humanize(sub)), to: `/desk/${encodeURIComponent(sub)}` });
    } else if (self) {
      crumbs.push({ label: __(module.description || humanize(module.link)), to: `/desk/${encodeURIComponent(module.link)}` });
    }
  } else if (moduleName && self) {
    crumbs.push({ label: __(humanize(moduleName)), to: `/desk/${encodeURIComponent(moduleName)}` });
  }
  return crumbs;
};

/**
 * Breadcrumbs: every ancestor on sm+; on phones only the closest one, after
 * "…" — the way back, with its destination written. The closest one reads as
 * the active section (where the page lives: the entity of a record); long
 * labels truncate with the full text on hover.
 */
function Breadcrumbs({ items, lead = false }) {
  if (!items.length) return null;
  const last = items.length - 1;
  return (
    <nav aria-label={__("Breadcrumb")} className="min-w-0">
      <ol className="flex min-w-0 flex-row items-center gap-1 text-sm text-muted-foreground">
        {/* After the top bar's app crumb. */}
        {lead && <li aria-hidden="true" className="flex shrink-0 items-center"><ChevronRightIcon className="size-3.5 opacity-60" /></li>}
        {items.length > 1 && (
          <li className="flex shrink-0 items-center gap-1 sm:hidden" aria-hidden="true">
            <span>…</span>
            <ChevronRightIcon className="size-3.5 opacity-60" />
          </li>
        )}
        {items.map((item, i) => (
          <li key={i} className={cn("flex min-w-0 items-center gap-1", i < last && "max-sm:hidden")}>
            <Link
              bare
              award={false}
              to={item.to}
              title={item.title || item.label}
              aria-current={i === last ? "location" : undefined}
              className={cn(
                "max-w-56 truncate rounded-sm hover:text-foreground hover:underline",
                i === last && "font-medium text-foreground"
              )}
            >
              {item.label}
            </Link>
            {i < last && <ChevronRightIcon className="size-3.5 shrink-0 opacity-60" />}
          </li>
        ))}
      </ol>
    </nav>
  );
}

const TRAIL_SLOT = "desk-trail"; // workspace/desk/src/top-nav.jsx

/**
 * The breadcrumbs go to the desk top bar (always in view, no row of their
 * own). Phones have no room there: they get them above the title, as does a
 * workspace without that slot.
 */
export function Trail({ items, portalOnly = false }) {
  const { nested } = useDocument() || {};
  const [slot, setSlot] = useState(undefined);
  useEffect(() => setSlot(document.getElementById(TRAIL_SLOT)), []);

  // A document inside another one (a page's contact form): the outer document owns the trail.
  if (nested || !items.length || slot === undefined) return null;
  if (portalOnly && !slot) return null;
  const inline = <div data-print-hide className={slot ? "sm:hidden" : undefined}><Breadcrumbs items={items} /></div>;
  if (!slot) return inline;
  // The top bar shows the app itself (its selector): the document adds what follows.
  const rest = items.filter((item) => !item.app);
  return (
    <>
      {rest.length > 0 && createPortal(<div className="min-w-0 max-sm:hidden"><Breadcrumbs items={rest} lead /></div>, slot)}
      {!portalOnly && inline}
    </>
  );
}

/**
 * Trail of a document without a header (Page Builder pages, desk pages with
 * `hasHeader: false`): only the top bar shows where it sits — app › module ›
 * the document itself (active), or app › Home for an app's home. Nothing
 * outside the desk (websites have no top-bar slot) nor in modals.
 */
export function PageTrail() {
  const { Document = {}, inModal } = useDocument();
  const { __META__ } = useWorkspace();
  const { search } = useLocation();
  const apps = Array.isArray(__META__?.menu_data) ? __META__.menu_data : [];
  const { Entity = {} } = Document;
  if (inModal || !Entity.name) return null;

  const items = homeCrumbs(apps, Document, search) || [
    ...moduleCrumbs(apps, Entity.module),
    { label: __(Entity.name), to: `/desk/${encodeURIComponent(Entity.name)}/view` },
  ];
  return <Trail items={items} portalOnly />;
}
