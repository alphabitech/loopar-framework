import { Link } from "@link";
import { cn } from "@cn/lib/utils";

/**
 * Underline tabs for the header's third row (`headerTabs`): links, one per
 * item `{ key, label, to, count?, active }`.
 */
export function HeaderTabs({ items, label }) {
  return (
    <nav aria-label={label} className="flex w-max min-w-full flex-row gap-1">
      {items.map((t) => (
        <Link
          key={t.key}
          award={false}
          bare
          to={t.to}
          aria-current={t.active ? "page" : undefined}
          className={cn(
            "-mb-px inline-flex shrink-0 items-center gap-2 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors",
            t.active ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
          )}
        >
          {t.label}
          {t.count != null && (
            <span className={cn(
              "rounded-full px-1.5 text-xs tabular-nums",
              t.active ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"
            )}>
              {t.count}
            </span>
          )}
        </Link>
      ))}
    </nav>
  );
}
