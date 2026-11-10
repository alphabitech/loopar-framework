import { useDesigner } from "@context/designer-context";
import { cn } from "@cn/lib/utils";
import { rootProps } from "./base/content-lines.js";

const HEIGHT = {
  xs: "h-2 md:h-4",
  sm: "h-4 md:h-8",
  md: "h-8 md:h-12",
  lg: "h-12 md:h-20",
  xl: "h-16 md:h-32",
};

/** Empty vertical space with responsive height. */
export default function Spacer(props) {
  const { designing } = useDesigner();
  const data = props.data || {};

  return (
    <div
      {...rootProps(props)}
      aria-hidden="true"
      className={cn(
        HEIGHT[data.height] || HEIGHT.md,
        designing && "rounded border border-dashed border-muted-foreground/30",
        props.className
      )}
    />
  );
}

Spacer.dontHaveMetaElements = ["text", "label"];

Spacer.metaFields = () => [
  {
    group: "custom",
    elements: {
      height: {
        element: SELECT,
        data: {
          label: "Height",
          options: [
            { value: "xs", label: "Extra Small" },
            { value: "sm", label: "Small" },
            { value: "md", label: "Medium" },
            { value: "lg", label: "Large" },
            { value: "xl", label: "Extra Large" },
          ],
          selected: "md",
        },
      },
    },
  },
];
