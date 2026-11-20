import loopar from "loopar";
import { useLocation } from "react-router";
import { cn } from "@cn/lib/utils";
import { Link } from "@link";
import Icon from "@icon";
import { FileCogIcon, LayoutDashboardIcon, LayoutGridIcon, ListIcon } from "lucide-react";
import { useWorkspace } from "@workspace/workspace-provider";
import { useDocument } from "@loopar/document";
import { useDesigner } from "@context/designer-context";
import { __ } from "@global/i18n";

const KIND_ICON = { list: ListIcon, single: FileCogIcon, page: LayoutDashboardIcon };

/** "my_module" → "My module": submodules come by name. */
const humanize = (name) => {
  const s = String(name || "").replace(/[-_]+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
};

const PLACEHOLDER = {
  name: "app",
  description: "App",
  modules: [1, 2, 3].map(i => ({
    link: "",
    description: `Module ${i}`,
    icon: "LayoutGrid",
    docs: [{ name: "Document", kind: "list", link: "" }, { name: "Settings", kind: "single", link: "" }],
    sections: [],
  })),
};

/**
 * The app this element shows: the one set in the editor, else `?app=` (the
 * App Home every app without a home of its own opens), else the app whose
 * home is this page.
 */
function useApp(data) {
  const { __META__ } = useWorkspace();
  const { Document } = useDocument() || {};
  const { search } = useLocation();
  const apps = Array.isArray(__META__?.menu_data) ? __META__.menu_data : [];
  const page = Document?.Entity?.name;
  const fromQuery = new URLSearchParams(search).get("app");

  return (data.app && apps.find(a => a.name === data.app))
    || (fromQuery && apps.find(a => a.name === fromQuery))
    || (!data.app && !fromQuery && apps.find(a => a.home === page))
    || null;
}

function DocLink({ doc, designing }) {
  const KindIcon = KIND_ICON[doc.kind] || ListIcon;
  const body = (
    <>
      <KindIcon className="h-4 w-4 shrink-0 text-muted-foreground group-hover:text-primary" />
      <span className="min-w-0 flex-1 truncate">{__(doc.name)}</span>
    </>
  );
  const cls = "group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground";

  return designing
    ? <div className={cls}>{body}</div>
    : <Link award={false} bare to={doc.link} className={cn(cls, "transition-colors hover:bg-secondary/60 hover:text-foreground")}>{body}</Link>;
}

function ModuleCard({ module, designing }) {
  const title = (
    <>
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <Icon data={{ icon: module.icon || "LayoutGrid" }} className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1 truncate font-semibold">{__(module.description)}</span>
    </>
  );
  const titleCls = "flex items-center gap-2 px-2 pb-2 text-foreground";

  return (
    <section className="mb-4 break-inside-avoid rounded-xl border bg-card p-2">
      {designing || !module.link
        ? <div className={titleCls}>{title}</div>
        : <Link award={false} bare to={`/desk/${module.link}`} title={__("Open module")} className={cn(titleCls, "hover:text-primary")}>{title}</Link>}
      <div className="flex flex-col">
        {(module.docs || []).map(doc => <DocLink key={doc.link || doc.name} doc={doc} designing={designing} />)}
        {(module.sections || []).map(section => (
          <div key={section.name} className="mt-2">
            <h4 className="px-2 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {__(humanize(section.name))}
            </h4>
            {section.docs.map(doc => <DocLink key={doc.link || doc.name} doc={doc} designing={designing} />)}
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * Desk page element: every module of an app as a card listing the documents
 * it opens (lists, settings, pages), Frappe-workspace style — any document of
 * the app is one click away. Built from the desk menu, already filtered by the
 * viewer's permissions.
 */
export default function AppLinks(props) {
  const data = props.data || {};
  const { designerMode } = useDesigner();
  const found = useApp(data);
  const app = found || (designerMode ? PLACEHOLDER : null);
  const showHeader = loopar.utils.trueValue(data.show_header);

  if (!app) return null;
  const modules = (app.modules || []).filter(m => (m.docs || []).length || (m.sections || []).length);

  return (
    <div className={cn("w-full", props.className)}>
      {showHeader && (
        <header className="mb-6 flex items-center gap-3">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            {app.icon ? <Icon data={{ icon: app.icon }} className="h-6 w-6" /> : <LayoutGridIcon className="h-6 w-6" />}
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-semibold tracking-tight">{__(app.description || app.name)}</h1>
            <p className="text-sm text-muted-foreground">{modules.length} {__(modules.length === 1 ? "module" : "modules")}</p>
          </div>
        </header>
      )}
      {data.label && <h3 className="mb-3 font-semibold">{__(data.label)}</h3>}
      {modules.length
        ? (
          <div className="gap-4 [column-width:16rem]">
            {modules.map((m, i) => <ModuleCard key={m.link || i} module={m} designing={!!designerMode} />)}
          </div>
        )
        : <p className="text-sm text-muted-foreground">{__("Nothing to open here yet.")}</p>}
    </div>
  );
}

AppLinks.dontHaveMetaElements = ["name", "text"];

AppLinks.metaFields = () => [
  {
    group: "content",
    elements: {
      app: { element: INPUT, data: { label: "App", description: "Empty = the app this page is the home of (or ?app= in the URL)." } },
      show_header: { element: SWITCH, data: { label: "Show header", description: "The app's icon and name above the cards." } },
    },
  },
];
