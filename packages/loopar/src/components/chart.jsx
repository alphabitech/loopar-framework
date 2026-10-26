import { cn } from "@cn/lib/utils";
import { useDesigner } from "@context/designer-context";
import { ChartView, useChartData, SAMPLE_CHART } from "@loopar/components/desk/chart-view";

/**
 * Desk page element: a Dashboard Chart (bar / line / area / donut). The chart
 * record holds the query; the element only picks it and how it looks.
 */
export default function Chart(props) {
  const data = props.data || {};
  const { designerMode } = useDesigner();
  const { loading, data: series } = useChartData(data.chart, { designing: designerMode });

  if (series?.denied) return null;

  const height = Math.min(Math.max(parseInt(data.height, 10) || 260, 120), 640);

  return (
    <div className={cn("w-full rounded-xl border bg-card p-4", props.className)}>
      <div className="mb-3">
        <div className="font-semibold">{data.label || series?.label || data.chart || "Chart"}</div>
        {data.description && <div className="text-sm text-muted-foreground">{data.description}</div>}
      </div>
      <ChartView
        data={designerMode ? SAMPLE_CHART : series}
        type={data.chart_type || undefined}
        height={height}
        format={data.format}
        loading={!designerMode && loading}
      />
    </div>
  );
}

Chart.dontHaveMetaElements = ["name", "text"];

Chart.metaFields = () => [
  {
    group: "content",
    elements: {
      chart: { element: SELECT, data: { label: "Chart", options: "Dashboard Chart", description: "A Dashboard Chart record." } },
      chart_type: { element: SELECT, data: { label: "Show as", options: "\nbar\nline\narea\ndonut", description: "Empty = the chart's own type." } },
      height: { element: INPUT, data: { label: "Height (px)", format: "int", default_value: 260 } },
      format: { element: SELECT, data: { label: "Format", options: "number\ncurrency" } },
      description: { element: INPUT, data: { label: "Description" } },
    },
  },
];
