import { useDesigner } from "@context/designer-context";
import { cn } from "@cn/lib/utils";
import { parseLines, rootProps } from "./base/content-lines.js";

const SAMPLE = "Request a quote | Tell us about your project.\nVisit & estimate | We measure and give you a clear price.\nWe do the work | On time, clean and guaranteed.";

/** Numbered process ("How we work"): one step per line, `Title | Description`. */
export default function Steps(props) {
  const { designing } = useDesigner();
  const data = props.data || {};
  const steps = parseLines(data.items || (designing ? SAMPLE : ""), 2);
  if (!steps.length) return null;

  const horizontal = data.orientation === "horizontal";

  return (
    <div {...rootProps(props)}>
      <ol className={cn("grid gap-8", horizontal ? "md:grid-flow-col md:auto-cols-fr" : "gap-6")}>
        {steps.map(([title, description], i) => (
          <li key={i} className={cn("relative flex gap-4", horizontal && "md:flex-col md:items-center md:text-center")}>
            <span className="relative z-10 flex size-10 shrink-0 items-center justify-center rounded-full bg-primary font-semibold text-primary-foreground">
              {i + 1}
            </span>
            {i < steps.length - 1 && (
              <span
                aria-hidden="true"
                className={cn(
                  "absolute bg-border",
                  horizontal
                    ? "left-5 top-10 h-[calc(100%-1rem)] w-px md:left-[calc(50%+1.5rem)] md:top-5 md:h-px md:w-[calc(100%-1rem)]"
                    : "left-5 top-10 h-[calc(100%-1rem)] w-px"
                )}
              />
            )}
            <div className="space-y-1 pt-1.5">
              <h3 className="font-semibold">{title}</h3>
              {description && <p className="text-pretty text-muted-foreground">{description}</p>}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

Steps.dontHaveMetaElements = ["text"];

Steps.metaFields = () => [
  {
    group: "custom",
    elements: {
      items: {
        element: TEXTAREA,
        data: { label: "Steps", description: "One step per line: Title | Description", rows: 6 },
      },
      orientation: {
        element: SELECT,
        data: { label: "Orientation", options: [{ value: "vertical", label: "Vertical" }, { value: "horizontal", label: "Horizontal (desktop)" }] },
      },
    },
  },
];
