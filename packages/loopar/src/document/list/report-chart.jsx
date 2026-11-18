import { ChartView } from "@loopar/components/desk/chart-view";

/** Chart of a report (loads on demand: it brings the charting library). */
export default function ReportChart({ type, labels, values }) {
  return <ChartView data={{ type, labels, values }} height={260} />;
}
