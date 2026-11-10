import { cn } from "@cn/lib/utils";
import { rootProps } from "./base/content-lines.js";

const SPACING = { sm: "my-2", md: "my-6", lg: "my-12" };
const STYLE = { solid: "border-solid", dashed: "border-dashed", dotted: "border-dotted" };

/** Horizontal rule, optionally with a centered label ("or", a section name…). */
export default function Separator(props) {
  const data = props.data || {};
  const line = cn("flex-1 border-t border-border", STYLE[data.line_style] || STYLE.solid);

  return (
    <div {...rootProps(props)} className={cn(SPACING[data.spacing] || SPACING.md, props.className)}>
      {data.label ? (
        <div className="flex items-center gap-4" role="separator">
          <span className={line} />
          <span className="text-sm text-muted-foreground">{data.label}</span>
          <span className={line} />
        </div>
      ) : (
        <hr className={line} />
      )}
    </div>
  );
}

Separator.dontHaveMetaElements = ["text"];

Separator.metaFields = () => [
  {
    group: "custom",
    elements: {
      spacing: {
        element: SELECT,
        data: { label: "Spacing", options: [{ value: "sm", label: "Small" }, { value: "md", label: "Medium" }, { value: "lg", label: "Large" }], selected: "md" },
      },
      line_style: {
        element: SELECT,
        data: { label: "Line Style", options: [{ value: "solid", label: "Solid" }, { value: "dashed", label: "Dashed" }, { value: "dotted", label: "Dotted" }] },
      },
    },
  },
];
