import BaseText from "@base-text";
import { ComponentDefaults } from "./base/ComponentDefaults";
import { useDesigner } from "@context/designer-context";
import { cn } from "@cn/lib/utils";
import { rootProps } from "./base/root-props.js";

const LEVELS = ["h1", "h2", "h3", "h4", "h5", "h6"];

/** Visual size, independent from the semantic level. */
const SIZES = {
  display: "text-4xl md:text-6xl lg:leading-[1.1]",
  "5xl": "text-4xl md:text-5xl",
  "4xl": "text-3xl md:text-4xl",
  "3xl": "text-2xl md:text-3xl",
  "2xl": "text-xl md:text-2xl",
  xl: "text-lg md:text-xl",
  lg: "text-base md:text-lg",
  md: "text-base",
  sm: "text-sm",
};

/** Size used when none is chosen: each level has its natural step. */
const LEVEL_SIZE = { h1: "display", h2: "5xl", h3: "4xl", h4: "3xl", h5: "2xl", h6: "xl" };

export default function Heading(props) {
  const { designing } = useDesigner();
  const { getText } = BaseText({ ...props, defaultText: "Heading" });
  const { data, getTextAlign } = ComponentDefaults(props);

  const Tag = LEVELS.includes(data.level) ? data.level : "h2";
  const size = SIZES[data.size] || SIZES[LEVEL_SIZE[Tag]];

  return (
    <Tag
      {...rootProps(props)}
      className={cn("font-bold leading-tight tracking-tighter", size, getTextAlign(), props.className)}
      style={designing
        ? { ...(props.style || {}), display: "-webkit-box", WebkitLineClamp: 5, WebkitBoxOrient: "vertical", overflow: "hidden" }
        : props.style}
    >
      {getText()}
    </Tag>
  );
}

Heading.metaFields = () => [
  {
    group: "custom",
    elements: {
      level: {
        element: SELECT,
        data: {
          label: "Level",
          description: "Semantic level (SEO/accessibility). Use a single H1 per page.",
          options: LEVELS.map((l) => ({ value: l, label: l.toUpperCase() })),
          selected: "h2",
        },
      },
      size: {
        element: SELECT,
        data: {
          label: "Size",
          description: "Visual size. Empty = the level's default size.",
          options: [
            { value: "", label: "Auto (by level)" },
            ...Object.keys(SIZES).map((s) => ({ value: s, label: s === "display" ? "Display" : s })),
          ],
        },
      },
    },
  },
];
