import { useDesigner } from "@context/designer-context";
import { cn } from "@cn/lib/utils";
import { parseLines, rootProps } from "./base/content-lines.js";

const SAMPLE = "Request a quote | Tell us about your project.\nVisit & estimate | We measure and give you a clear price.\nWe do the work | On time, clean and guaranteed.";

// Chevron shades, darkest first; cycled when there are more steps than shades.
const ARROW_SHADES = ["bg-primary", "bg-primary/85", "bg-primary/70", "bg-primary/55"];

/** Chained chevrons: each step is an arrow pointing to the next one (stacked blocks on mobile). */
function ArrowSteps({ steps }) {
  return (
    <ol className="grid gap-4 md:grid-flow-col md:auto-cols-fr md:gap-0">
      {steps.map(([title, description], i) => (
        <li key={i} className="flex flex-col gap-3">
          <div
            className={cn(
              "flex min-h-20 items-center gap-3 rounded-lg px-5 py-4 text-primary-foreground md:rounded-none md:pr-8",
              ARROW_SHADES[i % ARROW_SHADES.length],
              i === 0
                ? "md:[clip-path:polygon(0_0,calc(100%-1.5rem)_0,100%_50%,calc(100%-1.5rem)_100%,0_100%)]"
                : "md:-ml-3 md:pl-10 md:[clip-path:polygon(0_0,calc(100%-1.5rem)_0,100%_50%,calc(100%-1.5rem)_100%,0_100%,1.5rem_50%)]"
            )}
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary-foreground/20 text-sm font-semibold">
              {i + 1}
            </span>
            <h3 className="text-balance font-semibold leading-tight text-inherit">{title}</h3>
          </div>
          {description && <p className="text-pretty px-1 text-sm text-muted-foreground md:pr-6">{description}</p>}
        </li>
      ))}
    </ol>
  );
}

/** Numbered process ("How we work"): one step per line, `Title | Description`. */
export default function Steps(props) {
  const { designing } = useDesigner();
  const data = props.data || {};
  const steps = parseLines(data.items || (designing ? SAMPLE : ""), 2);
  if (!steps.length) return null;

  if (data.variant === "arrows") {
    return (
      <div {...rootProps(props)}>
        <ArrowSteps steps={steps} />
      </div>
    );
  }

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
      variant: {
        element: SELECT,
        data: {
          label: "Style",
          options: [{ value: "numbered", label: "Numbered" }, { value: "arrows", label: "Arrows (chained)" }],
          default_value: "numbered",
        },
      },
      orientation: {
        element: SELECT,
        data: { label: "Orientation", options: [{ value: "vertical", label: "Vertical" }, { value: "horizontal", label: "Horizontal (desktop)" }] },
      },
    },
  },
];
