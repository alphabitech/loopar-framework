import { useEffect, useState } from "react";
import loopar from "loopar";
import {
  BarChart, Bar, LineChart, Line, AreaChart, Area, PieChart, Pie, Cell,
  XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer,
} from "recharts";
import { formatNumber } from "./use-desk-element";

export const CHART_PALETTE = [
  "var(--color-primary)",
  "#3B82F6",
  "#F59E0B",
  "#EC4899",
  "#14B8A6",
  "#8B5CF6",
  "#EF4444",
  "var(--color-muted-foreground)",
];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Short axis label of a time bucket ('2026-10-25', '2026-10', '2026'). */
function bucketLabel(bucket, grain) {
  if (!grain) return bucket;
  if (grain === "year") return bucket;
  const [y, m, d] = bucket.split("-");
  if (grain === "month") return `${MONTHS[Number(m) - 1]} ${y.slice(2)}`;
  return `${MONTHS[Number(m) - 1]} ${Number(d)}`;
}

function ChartTooltip({ active, payload, label, format }) {
  if (!active || !payload?.length) return null;
  const item = payload[0];
  return (
    <div className="rounded-md border bg-popover px-3 py-2 text-xs shadow-md">
      <div className="mb-0.5 text-muted-foreground">{item.payload?.full ?? label}</div>
      <div className="font-semibold tabular-nums">{formatNumber(item.value, format)}</div>
    </div>
  );
}

/** Fetches a Dashboard Chart's series once per name. */
export function useChartData(chart, { designing = false } = {}) {
  const [state, setState] = useState({ loading: !designing && !!chart, data: null });

  useEffect(() => {
    if (designing || !chart) return;
    let alive = true;
    setState(s => ({ ...s, loading: true }));

    loopar.call("Dashboard Chart", "data", { query: { name: chart }, freeze: false })
      .then(data => alive && setState({ loading: false, data: data || {} }))
      .catch(e => alive && setState({ loading: false, data: { issue: e?.message || "Could not load" } }));

    return () => { alive = false; };
  }, [chart, designing]);

  return state;
}

const SAMPLE = {
  type: "bar",
  labels: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
  values: [4, 7, 5, 9, 6, 11, 8],
};

/**
 * Renders a chart series ({ type, labels, values, grain }) with recharts.
 * `type` overrides the series' own type (the element can force one).
 */
export function ChartView({ data, type, height = 260, format, loading }) {
  if (loading) {
    return <div className="flex items-center justify-center text-sm text-muted-foreground" style={{ height }}>…</div>;
  }
  if (!data || data.issue) {
    return <div className="flex items-center justify-center px-4 text-center text-sm text-muted-foreground" style={{ height }}>{data?.issue || "No data"}</div>;
  }

  const kind = type || data.type || "bar";
  const rows = (data.labels || []).map((label, i) => ({
    label: bucketLabel(label, data.grain),
    full: label,
    value: data.values?.[i] ?? 0,
  }));

  if (!rows.length) {
    return <div className="flex items-center justify-center text-sm text-muted-foreground" style={{ height }}>No data</div>;
  }

  const axis = { stroke: "var(--color-muted-foreground)", fontSize: 12, tickLine: false, axisLine: false };
  const tooltip = <Tooltip content={<ChartTooltip format={format} />} cursor={{ fill: "var(--color-secondary)", opacity: 0.4 }} />;
  const grid = <CartesianGrid vertical={false} stroke="var(--color-border)" />;
  const xAxis = <XAxis dataKey="label" {...axis} minTickGap={12} />;
  const yAxis = <YAxis {...axis} width={44} tickFormatter={v => formatNumber(v)} />;
  const color = CHART_PALETTE[0];

  if (kind === "donut") {
    const total = rows.reduce((a, r) => a + Number(r.value || 0), 0);
    return (
      <div className="flex flex-col items-center gap-3 sm:flex-row" style={{ minHeight: height }}>
        <div className="relative w-full sm:w-1/2" style={{ height }}>
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={rows} dataKey="value" nameKey="label" innerRadius="58%" outerRadius="85%" paddingAngle={2} stroke="none">
                {rows.map((_, i) => <Cell key={i} fill={CHART_PALETTE[i % CHART_PALETTE.length]} />)}
              </Pie>
              {tooltip}
            </PieChart>
          </ResponsiveContainer>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-2xl font-semibold tabular-nums">{formatNumber(total, format)}</span>
            <span className="text-xs text-muted-foreground">Total</span>
          </div>
        </div>
        <ul className="w-full space-y-1.5 text-sm sm:w-1/2">
          {rows.map((r, i) => (
            <li key={r.full} className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: CHART_PALETTE[i % CHART_PALETTE.length] }} />
              <span className="min-w-0 flex-1 truncate">{r.label}</span>
              <span className="tabular-nums text-muted-foreground">{formatNumber(r.value, format)}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        {kind === "line" ? (
          <LineChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            {grid}{xAxis}{yAxis}{tooltip}
            <Line dataKey="value" stroke={color} strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
          </LineChart>
        ) : kind === "area" ? (
          <AreaChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            {grid}{xAxis}{yAxis}{tooltip}
            <Area dataKey="value" stroke={color} fill={color} fillOpacity={0.15} strokeWidth={2} />
          </AreaChart>
        ) : (
          <BarChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            {grid}{xAxis}{yAxis}{tooltip}
            <Bar dataKey="value" fill={color} radius={[4, 4, 0, 0]} maxBarSize={48} />
          </BarChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}

export { SAMPLE as SAMPLE_CHART };
