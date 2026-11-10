import { Check, X } from "lucide-react";
import { Link } from "@link";
import { useDesigner } from "@context/designer-context";
import { cn } from "@cn/lib/utils";
import { parseLines, isOn, rootProps } from "./base/content-lines.js";

const SAMPLE_FEATURES = "Free estimate\nMaterials included\n- Weekend service";

/**
 * One plan of a pricing table (place several in a row). Features go one per
 * line; a line starting with "-" is shown as not included.
 */
export default function PricingPlan(props) {
  const { designing } = useDesigner();
  const data = props.data || {};
  const highlighted = isOn(data.highlighted);
  const features = parseLines(data.features || (designing ? SAMPLE_FEATURES : "")).map(([line]) =>
    line.startsWith("-") ? { text: line.replace(/^-\s*/, ""), included: false } : { text: line, included: true }
  );

  return (
    <div {...rootProps(props)} className={cn("h-full", props.className)}>
      <div
        className={cn(
          "relative flex h-full flex-col gap-6 rounded-2xl border bg-card p-6 text-card-foreground md:p-8",
          highlighted && "border-primary shadow-lg ring-1 ring-primary"
        )}
      >
        {data.badge && (
          <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground">
            {data.badge}
          </span>
        )}

        <div className="space-y-2">
          <h3 className="text-lg font-semibold">{data.title || "Plan"}</h3>
          {data.text && <p className="text-sm text-muted-foreground">{data.text}</p>}
        </div>

        <p className="flex items-baseline gap-1">
          <span className="text-4xl font-bold tracking-tight">{data.price || (designing ? "$99" : "")}</span>
          {data.period && <span className="text-sm text-muted-foreground">{data.period}</span>}
        </p>

        {features.length > 0 && (
          <ul className="flex-1 space-y-3 text-sm">
            {features.map((f, i) => (
              <li key={i} className={cn("flex items-start gap-2", !f.included && "text-muted-foreground line-through")}>
                {f.included
                  ? <Check className="mt-0.5 size-4 shrink-0 text-primary" />
                  : <X className="mt-0.5 size-4 shrink-0" />}
                <span>{f.text}</span>
              </li>
            ))}
          </ul>
        )}

        {data.button_label && (
          <Link
            to={data.to || "#"}
            variant={highlighted ? "default" : "secondary"}
            className="w-full justify-center"
          >
            {data.button_label}
          </Link>
        )}
      </div>
    </div>
  );
}

PricingPlan.metaFields = () => [
  {
    group: "custom",
    elements: {
      price: { element: INPUT, data: { label: "Price", description: "As shown, e.g. $99 or From L 1,500." } },
      period: { element: INPUT, data: { label: "Period", description: "e.g. /month, per visit." } },
      features: {
        element: TEXTAREA,
        data: { label: "Features", description: "One per line. Start a line with - to show it as not included.", rows: 6 },
      },
      button_label: { element: INPUT, data: { label: "Button Label" } },
      to: { element: INPUT, data: { label: "Button Link" } },
      highlighted: { element: SWITCH, data: { label: "Highlighted" } },
      badge: { element: INPUT, data: { label: "Badge", description: "e.g. Most popular." } },
    },
  },
];
