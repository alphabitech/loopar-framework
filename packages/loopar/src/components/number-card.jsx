import { cn } from "@cn/lib/utils";
import { Link } from "@link";
import Icon from "@icon";
import { useDeskElement, deskLink, formatNumber, filterField } from "@loopar/components/desk/use-desk-element";

/** Desk page element: one figure (count / sum / avg…) of an entity. */
export default function NumberCard(props) {
  const data = props.data || {};
  const { designing, loading, data: result } = useDeskElement(props.node);

  if (result?.denied) return null;

  const value = designing ? "123" : loading ? "…" : result?.issue ? "—" : formatNumber(result?.value, data.format);
  const to = deskLink(data.url || data.entity, "list");

  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm font-medium text-muted-foreground">{data.label || data.entity || "Number"}</span>
        {data.icon && <Icon data={{ icon: data.icon }} className="h-5 w-5 text-muted-foreground" />}
      </div>
      <div className="mt-2 text-3xl font-semibold tabular-nums" title={result?.issue || undefined}>
        {data.prefix}{value}{data.suffix}
      </div>
      {data.description && <div className="mt-1 text-xs text-muted-foreground">{data.description}</div>}
    </>
  );

  const className = cn("block w-full rounded-xl border bg-card p-4", to && !designing && "text-foreground transition-colors hover:border-primary/50 hover:text-foreground", props.className);

  if (designing || !to) return <div className={className}>{body}</div>;
  return <Link bare to={to} className={className}>{body}</Link>;
}

NumberCard.dontHaveMetaElements = ["name", "text"];

NumberCard.metaFields = () => [
  {
    group: "content",
    elements: {
      entity: { element: INPUT, data: { label: "Entity", placeholder: "Gym Member" } },
      aggregate: { element: SELECT, data: { label: "Value", options: "count\nsum\navg\nmin\nmax" } },
      field: { element: INPUT, data: { label: "Field", description: "Numeric field for sum / avg / min / max." } },
      filter: filterField(),
      format: { element: SELECT, data: { label: "Format", options: "number\ncurrency" } },
      prefix: { element: INPUT, data: { label: "Prefix", placeholder: "L " } },
      suffix: { element: INPUT, data: { label: "Suffix" } },
      icon: { element: ICON_INPUT, data: { label: "Icon" } },
      description: { element: INPUT, data: { label: "Description" } },
      url: { element: INPUT, data: { label: "Link", description: "Empty = the entity's list." } },
    },
  },
];
