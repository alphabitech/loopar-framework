import { cn } from "@cn/lib/utils";
import { Link } from "@link";
import { useDeskElement, timeAgo } from "@loopar/components/desk/use-desk-element";
import { __ } from "@global/i18n";

const VERB = { Created: "created", Updated: "updated", Deleted: "deleted", Restored: "restored" };

const SAMPLE = [
  { user: "maria", user_name: "Maria", action: "Updated", entity: "Customer", name: "Acme", title: "Acme", at: new Date(Date.now() - 5 * 60e3).toISOString(), live: true },
  { user: "jose", user_name: "José", action: "Created", entity: "Contact", name: "C-0012", title: "C-0012", at: new Date(Date.now() - 40 * 60e3).toISOString(), live: true },
];

const initials = (name) => String(name || "?").split(/\s+/).map(p => p[0]).join("").slice(0, 2).toUpperCase();

/**
 * Desk page element: what the rest of the team changed lately, from Document
 * History, on records the viewer can see (core/document/desk-home.js).
 */
export default function ActivityFeed(props) {
  const data = props.data || {};
  const { designing, loading, data: result } = useDeskElement(props.node);
  if (result?.denied) return null;
  const rows = designing ? SAMPLE : result?.rows || [];

  const link = (row) => row.single
    ? `/desk/${row.entity}/update`
    : `/desk/${row.entity}/update?name=${encodeURIComponent(row.name)}`;

  return (
    <section className={cn("w-full rounded-xl border bg-card", props.className, "space-y-0")}>
      <header className="border-b px-4 py-3">
        <span className="font-semibold">{__(data.label || "Team activity")}</span>
      </header>
      {loading && !designing ? (
        <div className="px-4 py-6 text-sm text-muted-foreground">…</div>
      ) : rows.length === 0 ? (
        <div className="px-4 py-6 text-sm text-muted-foreground">
          {__(data.empty_message || "Changes made by your team will show up here.")}
        </div>
      ) : (
        <ul className="divide-y">
          {rows.map(row => (
            <li key={`${row.entity}:${row.name}:${row.at}`} className="flex items-center gap-3 px-4 py-2.5 text-sm">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-medium text-primary" aria-hidden="true">
                {initials(row.user_name)}
              </span>
              <span className="min-w-0 flex-1 truncate">
                <span className="font-medium">{row.user_name}</span>{" "}
                <span className="text-muted-foreground">{__(VERB[row.action] || row.action)} {__(row.entity)}</span>{" "}
                {row.live && !designing
                  ? <Link bare to={link(row)} className="font-medium text-foreground hover:underline">{row.title}</Link>
                  : <span className="font-medium">{row.title}</span>}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground" title={String(row.at || "")}>{timeAgo(row.at)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

ActivityFeed.dontHaveMetaElements = ["name", "text"];

ActivityFeed.metaFields = () => [
  {
    group: "content",
    elements: {
      label: { element: INPUT, data: { label: "Title", placeholder: "Team activity" } },
      limit: { element: INPUT, data: { label: "Rows", format: "int", default_value: 8 } },
      empty_message: { element: INPUT, data: { label: "Empty message" } },
    },
  },
];
