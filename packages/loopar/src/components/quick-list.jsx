import loopar from "loopar";
import { cn } from "@cn/lib/utils";
import { Link } from "@link";
import { useDeskElement, filterField } from "@loopar/components/desk/use-desk-element";

const humanize = (name) => loopar.utils.Capitalize(String(name || "").replaceAll("_", " "));

/** Desk page element: the latest records of an entity. */
export default function QuickList(props) {
  const data = props.data || {};
  const { designing, loading, data: result } = useDeskElement(props.node);

  if (result?.denied) return null;

  const entity = result?.entity || data.entity;
  const fields = designing
    ? String(data.fields || "").split(",").map(f => f.trim()).filter(Boolean)
    : result?.fields || [];
  const rows = designing
    ? [1, 2, 3].map(i => ({ name: `${data.entity || "Record"} ${i}` }))
    : result?.rows || [];
  // Titles from the server: the row's own and those of its link fields.
  const title = (row) => result?.titles?.[row.name] ?? row.name;
  const display = (row, f) => String(result?.labels?.[f]?.[row[f]] ?? row[f] ?? "");

  return (
    <div className={cn("w-full rounded-xl border bg-card", props.className)}>
      <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
        <span className="font-semibold">{data.label || entity || "Quick list"}</span>
        {entity && !designing && (
          <Link bare to={`/desk/${entity}/list`} className="text-sm text-primary hover:underline">
            {data.view_all_label || "View all"}
          </Link>
        )}
      </div>
      {loading && !designing ? (
        <div className="px-4 py-6 text-sm text-muted-foreground">…</div>
      ) : rows.length === 0 ? (
        <div className="px-4 py-6 text-sm text-muted-foreground">{result?.issue || data.empty_message || "Nothing here yet."}</div>
      ) : (
        <ul className="divide-y">
          {rows.map(row => {
            const content = (
              <>
                <span className="truncate font-medium" title={row.name}>{title(row)}</span>
                {fields.filter(f => f !== "name").map(f => (
                  <span key={f} className="truncate text-sm text-muted-foreground" title={humanize(f)}>
                    {designing ? `{${f}}` : display(row, f)}
                  </span>
                ))}
              </>
            );
            const cls = "flex items-center justify-between gap-3 px-4 py-2.5";
            return (
              <li key={row.name}>
                {designing
                  ? <div className={cls}>{content}</div>
                  : <Link bare to={`/desk/${entity}/update?name=${encodeURIComponent(row.name)}`} className={cn(cls, "text-foreground hover:bg-secondary/40 hover:text-foreground")}>{content}</Link>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

QuickList.dontHaveMetaElements = ["name", "text"];

QuickList.metaFields = () => [
  {
    group: "content",
    elements: {
      entity: { element: INPUT, data: { label: "Entity", placeholder: "Gym Check In" } },
      fields: { element: INPUT, data: { label: "Fields", placeholder: "member, check_in_time", description: "Comma separated, shown next to the name." } },
      limit: { element: INPUT, data: { label: "Rows", format: "int", default_value: 5 } },
      filter: filterField(),
      view_all_label: { element: INPUT, data: { label: "View all label" } },
      empty_message: { element: INPUT, data: { label: "Empty message" } },
    },
  },
];
