import { cn } from "@cn/lib/utils";
import { Link } from "@link";
import { useDeskElement, formatNumber, timeAgo } from "@loopar/components/desk/use-desk-element";
import { __ } from "@global/i18n";

const SAMPLE = [
  { key: "backup", label: "Last backup", value: new Date(Date.now() - 6 * 3600e3).toISOString(), kind: "time", hint: "Automatic" },
  { key: "visits", label: "Website visits", value: 1284, kind: "number", hint: "Last 7 days" },
  { key: "users", label: "Users", value: 4, kind: "number", hint: "Enabled accounts" },
  { key: "errors", label: "Errors", value: 2, kind: "number", hint: "Last 24 hours", tone: "warning" },
];

/**
 * Desk page element: a row of system figures (last backup, website visits,
 * users, recent errors). Each figure appears only when its source is
 * installed and the viewer may see it (core/document/desk-home.js).
 */
export default function SystemStats(props) {
  const { designing, loading, data: result } = useDeskElement(props.node);
  if (result?.denied) return null;

  const items = designing ? SAMPLE : result?.items || [];
  if (!designing && !loading && !items.length) return null;

  const display = (item) => {
    if (item.kind === "time") return item.value ? timeAgo(item.value) : __("Never");
    return formatNumber(item.value);
  };

  return (
    <div className={cn("grid w-full grid-cols-2 gap-4 lg:grid-cols-4", props.className, "space-y-0")}>
      {(loading && !designing ? [1, 2, 3, 4].map(k => ({ key: k })) : items).map(item => {
        const body = (
          <>
            <div className="text-sm text-muted-foreground">{item.label ? __(item.label) : " "}</div>
            <div className={cn("mt-1 text-2xl font-semibold tabular-nums", item.tone === "warning" && "text-amber-600 dark:text-amber-400")}>
              {item.label ? display(item) : "…"}
            </div>
            {item.hint && <div className="mt-0.5 text-xs text-muted-foreground">{__(item.hint)}</div>}
          </>
        );
        const cls = "block rounded-xl border bg-card p-4";
        return designing || !item.to
          ? <div key={item.key} className={cls}>{body}</div>
          : <Link key={item.key} bare to={item.to} className={cn(cls, "text-foreground transition-colors hover:border-primary/50 hover:text-foreground")}>{body}</Link>;
      })}
    </div>
  );
}

SystemStats.dontHaveMetaElements = ["name", "text"];
SystemStats.metaFields = () => [];
