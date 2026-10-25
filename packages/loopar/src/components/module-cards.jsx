import { cn } from "@cn/lib/utils";
import { Link } from "@link";
import Icon from "@icon";
import { ChevronRightIcon } from "lucide-react";
import { useWorkspace } from "@workspace/workspace-provider";
import { useDocument } from "@loopar/document";
import { useDesigner } from "@context/designer-context";

/**
 * Desk page element: a card per module of the page's app, the ones the user
 * can reach (taken from the desk menu, already filtered by permissions).
 */
export default function ModuleCards(props) {
  const data = props.data || {};
  const { __META__ } = useWorkspace();
  const menuData = __META__?.menu_data;
  const { Document } = useDocument() || {};
  const { designerMode } = useDesigner();

  const page = Document?.Entity?.name;
  const app = (Array.isArray(menuData) ? menuData : []).find(a =>
    (data.app && a.name === data.app) || (!data.app && a.home === page)
  );

  const modules = designerMode && !app
    ? [{ link: "", description: "Module", icon: "LayoutGrid" }, { link: "", description: "Module", icon: "LayoutGrid" }]
    : app?.modules || [];

  if (!modules.length) return null;

  return (
    <div className={cn("w-full", props.className)}>
      {data.label && <h3 className="mb-3 font-semibold">{data.label}</h3>}
      <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(14rem,1fr))]">
        {modules.map((m, i) => {
          const body = (
            <>
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-secondary">
                <Icon data={{ icon: m.icon || "LayoutGrid" }} className="h-5 w-5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{m.description}</span>
                <span className="block text-xs text-muted-foreground">{(m.routes || []).length} documents</span>
              </span>
              <ChevronRightIcon className="h-4 w-4 text-muted-foreground" />
            </>
          );
          const cls = "flex items-center gap-3 rounded-xl border bg-card p-3";
          return designerMode
            ? <div key={i} className={cls}>{body}</div>
            : <Link key={m.link} bare to={`/desk/${m.link}`} className={cn(cls, "text-foreground transition-colors hover:border-primary/50 hover:text-foreground")}>{body}</Link>;
        })}
      </div>
    </div>
  );
}

ModuleCards.dontHaveMetaElements = ["name", "text"];

ModuleCards.metaFields = () => [
  {
    group: "content",
    elements: {
      app: { element: INPUT, data: { label: "App", description: "Empty = the app this page is the home of." } },
    },
  },
];
