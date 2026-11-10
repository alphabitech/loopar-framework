import { Droppable } from "@droppable";
import { cn } from "@cn/lib/utils";

/** Minimum width of each item; the grid fits as many columns as there is room for. */
const MIN_WIDTH = { xs: "10rem", sm: "12rem", md: "16rem", lg: "20rem", xl: "24rem" };
const GAP = { 0: "gap-0", 2: "gap-2", 4: "gap-4", 6: "gap-6", 8: "gap-8", 12: "gap-12" };

/**
 * Auto-fit grid for repeated items (cards, logos, team members): items wrap
 * by their minimum width, no fixed columns to maintain.
 */
export default function Grid(props) {
  const data = props.data || {};
  const min = MIN_WIDTH[data.min_width] || MIN_WIDTH.md;

  return (
    <Droppable
      {...props}
      className={cn("grid", GAP[data.gap] || "gap-6", props.className)}
      style={{
        ...(props.style || {}),
        gridTemplateColumns: `repeat(auto-fit, minmax(min(${min}, 100%), 1fr))`,
      }}
    />
  );
}

Grid.metaFields = () => [
  {
    group: "layout",
    elements: {
      min_width: {
        element: SELECT,
        data: {
          label: "Item min width",
          options: Object.entries(MIN_WIDTH).map(([value, rem]) => ({ value, label: `${value} (${rem})` })),
          selected: "md",
        },
      },
      gap: {
        element: SELECT,
        data: { label: "Gap", options: Object.keys(GAP).map((v) => ({ value: v, label: v })), selected: "6" },
      },
    },
  },
];
