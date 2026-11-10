import { Clock } from "lucide-react";
import { useDesigner } from "@context/designer-context";
import { parseLines, rootProps } from "./base/content-lines.js";

const SAMPLE = "Monday – Friday | 7:00 AM – 6:00 PM\nSaturday | 8:00 AM – 2:00 PM\nSunday | Closed";

/** Opening hours: one row per line, `Days | Hours`. */
export default function BusinessHours(props) {
  const { designing } = useDesigner();
  const data = props.data || {};
  const rows = parseLines(data.items || (designing ? SAMPLE : ""), 2);
  if (!rows.length) return null;

  return (
    <div {...rootProps(props)}>
      <div className="space-y-4 rounded-xl border bg-card p-6 text-card-foreground">
        {data.title && (
          <h3 className="flex items-center gap-2 font-semibold">
            <Clock className="size-5 text-primary" />
            {data.title}
          </h3>
        )}
        <dl className="divide-y divide-border text-sm">
          {rows.map(([days, hours], i) => (
            <div key={i} className="flex justify-between gap-4 py-2">
              <dt className="text-muted-foreground">{days}</dt>
              <dd className="text-right font-medium">{hours}</dd>
            </div>
          ))}
        </dl>
        {data.note && <p className="text-xs text-muted-foreground">{data.note}</p>}
      </div>
    </div>
  );
}


BusinessHours.metaFields = () => [
  {
    group: "custom",
    elements: {
      items: {
        element: TEXTAREA,
        data: { label: "Hours", description: "One per line: Days | Hours", rows: 6 },
      },
      note: { element: INPUT, data: { label: "Note", description: "e.g. Emergency service available 24/7." } },
    },
  },
];
