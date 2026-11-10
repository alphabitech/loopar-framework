import { cn } from "@cn/lib/utils";
import { Link } from "@link";
import { CircleCheckIcon, CircleIcon, ArrowRightIcon } from "lucide-react";
import { useDeskElement } from "@loopar/components/desk/use-desk-element";
import { __ } from "@global/i18n";

const SAMPLE = [
  { key: "a", label: "Company and logo", done: true },
  { key: "b", label: "Outgoing email", description: "SMTP for password resets, notifications and forms.", done: false, cta: "Configure" },
  { key: "c", label: "Automatic backups", done: false, cta: "Configure" },
];

/**
 * Desk page element: what this installation still needs (company, email,
 * backups, 2FA, website, users), checked live on the server
 * (core/document/desk-home.js). Only administrators see it, and it leaves
 * the page once everything is done.
 */
export default function SetupChecklist(props) {
  const data = props.data || {};
  const { designing, loading, data: result } = useDeskElement(props.node);

  if (!designing && (loading || result?.denied || result?.issue)) return null;

  const items = designing ? SAMPLE : result?.items || [];
  const done = items.filter(i => i.done).length;
  if (!designing && (!items.length || done === items.length)) return null;

  const pct = Math.round((done / items.length) * 100);
  // Pending first, in their own order: the next step is always on top.
  const ordered = [...items.filter(i => !i.done), ...items.filter(i => i.done)];

  return (
    <section className={cn("w-full rounded-xl border bg-card", props.className, "space-y-0")}>
      <header className="space-y-3 border-b px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <span className="font-semibold">{__(data.label || "Finish setting up")}</span>
          <span className="text-sm tabular-nums text-muted-foreground">{done} {__("of")} {items.length}</span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
        </div>
      </header>
      <ul className="divide-y">
        {ordered.map(item => (
          <li key={item.key} className="flex items-start gap-3 px-4 py-3">
            {item.done
              ? <CircleCheckIcon className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-label={__("Done")} />
              : <CircleIcon className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-label={__("Pending")} />}
            <div className="min-w-0 flex-1">
              <div className={cn("text-sm font-medium", item.done && "text-muted-foreground")}>{__(item.label)}</div>
              {!item.done && item.description && (
                <div className="mt-0.5 text-sm text-muted-foreground">{__(item.description)}</div>
              )}
            </div>
            {!item.done && item.cta && (
              designing
                ? <span className="shrink-0 text-sm text-primary">{__(item.cta)}</span>
                : (
                  <Link bare to={item.to} className="inline-flex shrink-0 items-center gap-1 text-sm font-medium text-primary hover:underline">
                    {__(item.cta)} <ArrowRightIcon className="h-3.5 w-3.5" />
                  </Link>
                )
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

SetupChecklist.dontHaveMetaElements = ["name", "text"];

SetupChecklist.metaFields = () => [
  {
    group: "content",
    elements: {
      label: { element: INPUT, data: { label: "Title", placeholder: "Finish setting up" } },
    },
  },
];
