import { useEffect, useMemo, useState } from "react";
import loopar from "loopar";
import { cn } from "@cn/lib/utils";
import { Link } from "@link";
import { PencilIcon, ExternalLinkIcon } from "lucide-react";
import { ChartView, useChartData } from "./chart-view";
import { formatNumber } from "./use-desk-element";

/** Item width on a 12-column grid (full width on phones). Static classes for Tailwind. */
const SPAN = {
  3: "md:col-span-6 xl:col-span-3",
  4: "md:col-span-6 xl:col-span-4",
  6: "md:col-span-6",
  8: "md:col-span-12 xl:col-span-8",
  12: "md:col-span-12",
};

export const parseItems = (value) => {
  const rows = Array.isArray(value) ? value : loopar.utils.JSONparse(value, []);
  return Array.isArray(rows) ? rows : [];
};

function useItemData(dashboard, item) {
  const [state, setState] = useState({ loading: true, data: null });

  useEffect(() => {
    if (!dashboard || !item.name) return;
    let alive = true;
    loopar.call("Dashboard", "itemData", { query: { name: dashboard, item: item.name }, freeze: false })
      .then(data => alive && setState({ loading: false, data: data || {} }))
      .catch(e => alive && setState({ loading: false, data: { issue: e?.message || "Could not load" } }));
    return () => { alive = false; };
  }, [dashboard, item.name]);

  return state;
}

function NumberItem({ dashboard, item }) {
  const { loading, data } = useItemData(dashboard, item);
  if (data?.denied) return null;

  return (
    <div className="flex h-full flex-col justify-between rounded-xl border bg-card p-4">
      <span className="text-sm font-medium text-muted-foreground">{item.label || item.entity}</span>
      <span className="mt-2 text-3xl font-semibold tabular-nums" title={data?.issue || undefined}>
        {item.prefix}{loading ? "…" : data?.issue ? "—" : formatNumber(data?.value, item.format)}
      </span>
    </div>
  );
}

function ChartItem({ item }) {
  const { loading, data } = useChartData(item.chart);
  if (data?.denied) return null;

  return (
    <div className="h-full rounded-xl border bg-card p-4">
      <div className="mb-3 font-semibold">{item.label || data?.label || item.chart}</div>
      <ChartView data={data} loading={loading} height={240} />
    </div>
  );
}

/**
 * A dashboard's items on a 12-column grid. `link` adds a header button:
 * "edit" (the dashboard's own page) or "open" (embedded in a Desk Page).
 */
export function DashboardBoard({ name, description, items: rawItems, link = "edit", title }) {
  const items = useMemo(() => parseItems(rawItems), [rawItems]);
  const href = name && (link === "edit"
    ? `/desk/Dashboard/update?name=${encodeURIComponent(name)}`
    : `/desk/Dashboard/view?name=${encodeURIComponent(name)}`);

  return (
    <div className="flex w-full flex-col gap-4">
      {(title || description || href) && (
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            {title && <h3 className="truncate font-semibold">{title}</h3>}
            {description && <p className="text-sm text-muted-foreground">{description}</p>}
          </div>
          {href && (
            <Link variant="secondary" to={href}>
              {link === "edit"
                ? <><PencilIcon className="mr-1 h-4 w-4" /> Edit</>
                : <><ExternalLinkIcon className="mr-1 h-4 w-4" /> Open</>}
            </Link>
          )}
        </div>
      )}

      {items.length === 0 ? (
        <div className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">
          This dashboard has no items yet. Edit it to add charts and numbers.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-12">
          {items.map(item => (
            <div key={item.name} className={cn("min-w-0", SPAN[item.width] || SPAN[6])}>
              {item.item_type === "number"
                ? <NumberItem dashboard={name} item={item} />
                : <ChartItem item={item} />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
