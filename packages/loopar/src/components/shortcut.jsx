import loopar from "loopar";
import { cn } from "@cn/lib/utils";
import { Link } from "@link";
import Icon from "@icon";
import { SquareArrowOutUpRightIcon } from "lucide-react";
import { useDeskElement, deskLink, formatNumber, filterField } from "@loopar/components/desk/use-desk-element";

/**
 * Desk page element: a big link to an entity, page or URL, with an optional
 * live counter. Built on Link, so it disappears for users without permission
 * on the target.
 */
export default function Shortcut(props) {
  const data = props.data || {};
  const showCount = loopar.utils.trueValue(data.show_count);
  const { designing, loading, data: result } = useDeskElement(props.node, showCount);
  const to = deskLink(data.url || data.target, data.action);
  const featured = loopar.utils.trueValue(data.featured);

  const body = (
    <>
      <span className={cn(
        "flex shrink-0 items-center justify-center rounded-lg",
        featured ? "h-12 w-12 bg-primary-foreground/15" : "h-10 w-10 bg-primary/10 text-primary"
      )}>
        {data.icon
          ? <Icon data={{ icon: data.icon }} className={featured ? "h-6 w-6" : "h-5 w-5"} />
          : <SquareArrowOutUpRightIcon className="h-5 w-5" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn("block truncate font-semibold", featured && "text-lg")}>{data.label || data.target || "Shortcut"}</span>
        {data.description && <span className={cn("block truncate text-sm", featured ? "opacity-80" : "text-muted-foreground")}>{data.description}</span>}
      </span>
      {showCount && !result?.denied && (
        <span className={cn(
          "rounded-full px-2.5 py-0.5 text-sm font-semibold tabular-nums",
          featured ? "bg-primary-foreground/20" : "bg-secondary"
        )}>
          {designing ? "#" : loading ? "…" : formatNumber(result?.value)}
        </span>
      )}
    </>
  );

  const className = cn(
    "flex w-full items-center gap-3 rounded-xl border p-4 text-left transition-colors",
    featured
      ? "border-primary bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground"
      : "bg-card text-foreground hover:border-primary/50 hover:bg-secondary/40 hover:text-foreground",
    props.className
  );

  if (designing || !to) return <div className={className}>{body}</div>;

  return <Link bare to={to} className={className}>{body}</Link>;
}

Shortcut.dontHaveMetaElements = ["name", "text"];

Shortcut.metaFields = () => [
  {
    group: "content",
    elements: {
      target: { element: INPUT, data: { label: "Target", placeholder: "Gym Member / Gym POS", description: "Entity or page it opens." } },
      action: { element: SELECT, data: { label: "Opens", options: "list\ncreate\nview", description: "list for entities, view for pages, create for a new record." } },
      url: { element: INPUT, data: { label: "URL", placeholder: "/desk/…", description: "Overrides Target + Opens." } },
      icon: { element: ICON_INPUT, data: { label: "Icon" } },
      description: { element: INPUT, data: { label: "Description" } },
      featured: { element: SWITCH, data: { label: "Featured", description: "Filled with the primary color: the main action of the page." } },
      show_count: { element: SWITCH, data: { label: "Show count", description: "Records of Target matching the filter." } },
      filter: filterField(),
    },
  },
];
