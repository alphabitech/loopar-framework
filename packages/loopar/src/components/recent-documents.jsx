import { cn } from "@cn/lib/utils";
import { Link } from "@link";
import { FileTextIcon } from "lucide-react";
import { useDeskElement, timeAgo } from "@loopar/components/desk/use-desk-element";
import { __ } from "@global/i18n";

const SAMPLE = [
  { entity: "Customer", name: "Acme", title: "Acme", at: new Date(Date.now() - 12 * 60e3).toISOString() },
  { entity: "Page", name: "Home", title: "Home", at: new Date(Date.now() - 3600e3).toISOString() },
  { entity: "User", name: "maria", title: "maria", at: new Date(Date.now() - 2 * 86400e3).toISOString() },
];

/**
 * Desk page element: the records the viewer created or edited last (from
 * Document History, see core/document/desk-home.js), to pick up where they
 * left off.
 */
export default function RecentDocuments(props) {
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
        <span className="font-semibold">{__(data.label || "Continue where you left off")}</span>
      </header>
      {loading && !designing ? (
        <div className="px-4 py-6 text-sm text-muted-foreground">…</div>
      ) : rows.length === 0 ? (
        <div className="px-4 py-6 text-sm text-muted-foreground">
          {__(data.empty_message || "The records you create or edit will show up here.")}
        </div>
      ) : (
        <ul className="divide-y">
          {rows.map(row => {
            const content = (
              <>
                <FileTextIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{row.title}</span>
                  <span className="block truncate text-xs text-muted-foreground">{__(row.entity)}</span>
                </span>
                <span className="shrink-0 text-xs text-muted-foreground" title={String(row.at || "")}>{timeAgo(row.at)}</span>
              </>
            );
            const cls = "flex items-center gap-3 px-4 py-2.5";
            return (
              <li key={`${row.entity}:${row.name}`}>
                {designing
                  ? <div className={cls}>{content}</div>
                  : <Link bare to={link(row)} className={cn(cls, "text-foreground hover:bg-secondary/40 hover:text-foreground")}>{content}</Link>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

RecentDocuments.dontHaveMetaElements = ["name", "text"];

RecentDocuments.metaFields = () => [
  {
    group: "content",
    elements: {
      label: { element: INPUT, data: { label: "Title", placeholder: "Continue where you left off" } },
      limit: { element: INPUT, data: { label: "Rows", format: "int", default_value: 6 } },
      empty_message: { element: INPUT, data: { label: "Empty message" } },
    },
  },
];
