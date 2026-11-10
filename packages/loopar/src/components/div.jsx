import { Droppable } from "@droppable";
import { useDesigner } from "@context/designer-context";
import { cn } from "@cn/lib/utils";

/**
 * Generic container (Webflow's "Div Block"): any safe HTML tag, an optional
 * inner text, and layout controls (flex / grid) so common arrangements don't
 * need hand-written classes.
 */

// Tags a page author may choose. No script/style/iframe/document-level tags:
// structure is authored here, behavior lives in components.
export const SAFE_TAGS = [
  "div", "section", "article", "aside", "header", "footer", "main", "nav", "figure", "figcaption",
  "p", "span", "strong", "em", "small", "blockquote", "pre", "code", "address",
  "ul", "ol", "li", "dl", "dt", "dd", "details", "summary",
  "h1", "h2", "h3", "h4", "h5", "h6",
];

const DISPLAY = { flex: "flex", grid: "grid", inline: "inline-block" };
const DIRECTION = { row: "flex-row", column: "flex-col", "row-reverse": "flex-row-reverse", "column-reverse": "flex-col-reverse" };
const ALIGN = { start: "items-start", center: "items-center", end: "items-end", stretch: "items-stretch", baseline: "items-baseline" };
const JUSTIFY = { start: "justify-start", center: "justify-center", end: "justify-end", between: "justify-between", around: "justify-around", evenly: "justify-evenly" };
const GAP = { 0: "gap-0", 1: "gap-1", 2: "gap-2", 3: "gap-3", 4: "gap-4", 6: "gap-6", 8: "gap-8", 12: "gap-12" };
const COLS = { 1: "grid-cols-1", 2: "grid-cols-2", 3: "grid-cols-3", 4: "grid-cols-4", 5: "grid-cols-5", 6: "grid-cols-6" };
// Stack the columns below md, as a row does.
const COLS_MD = { 1: "md:grid-cols-1", 2: "md:grid-cols-2", 3: "md:grid-cols-3", 4: "md:grid-cols-4", 5: "md:grid-cols-5", 6: "md:grid-cols-6" };

export function layoutClasses(data = {}) {
  const display = DISPLAY[data.display];
  if (!display) return "";
  const responsive = data.stack_on_mobile !== 0 && data.stack_on_mobile !== "0" && data.stack_on_mobile !== false;
  return cn(
    display,
    data.display === "flex" && (DIRECTION[data.direction] || "flex-row"),
    data.display === "flex" && [1, "1", true].includes(data.wrap) && "flex-wrap",
    data.display === "grid" && (responsive ? cn("grid-cols-1", COLS_MD[data.columns] || "md:grid-cols-2") : (COLS[data.columns] || "grid-cols-2")),
    data.display !== "inline" && ALIGN[data.align],
    data.display !== "inline" && JUSTIFY[data.justify],
    data.display !== "inline" && GAP[data.gap],
  );
}

export default function Div(props) {
  const { designing } = useDesigner();
  const data = props.data || {};
  const tag = SAFE_TAGS.includes(String(data.tag || "").toLowerCase()) ? String(data.tag).toLowerCase() : "div";
  const hasChildren = Array.isArray(props.elements) && props.elements.length > 0;

  // Text only (no children): render the text inside the chosen tag.
  if (data.text && !hasChildren && !designing) {
    const Tag = tag;
    const { className, style, ref } = props;
    return <Tag className={cn(layoutClasses(data), className)} style={style} ref={ref} {...(data.id ? { id: data.id } : {})}>{data.text}</Tag>;
  }

  return (
    <Droppable
      {...props}
      Component={tag}
      className={cn(layoutClasses(data), props.className)}
    >
      {data.text || null}
    </Droppable>
  );
}

Div.metaFields = () => [
  {
    group: "html",
    elements: {
      tag: {
        element: SELECT,
        data: { label: "Tag", options: SAFE_TAGS.map((t) => ({ value: t, label: t })), selected: "div" },
      },
    },
  },
  {
    group: "layout",
    elements: {
      display: {
        element: SELECT,
        data: {
          label: "Display",
          options: [{ value: "", label: "Block (default)" }, { value: "flex", label: "Flex" }, { value: "grid", label: "Grid" }, { value: "inline", label: "Inline block" }],
        },
      },
      direction: {
        element: SELECT,
        data: {
          label: "Direction (flex)",
          options: [{ value: "row", label: "Row" }, { value: "column", label: "Column" }, { value: "row-reverse", label: "Row reverse" }, { value: "column-reverse", label: "Column reverse" }],
        },
      },
      wrap: { element: SWITCH, data: { label: "Wrap (flex)" } },
      columns: {
        element: SELECT,
        data: { label: "Columns (grid)", options: ["1", "2", "3", "4", "5", "6"] },
      },
      stack_on_mobile: { element: SWITCH, data: { label: "One column on mobile (grid)", default_value: 1 } },
      align: {
        element: SELECT,
        data: { label: "Align items", options: [{ value: "", label: "Default" }, ...Object.keys(ALIGN).map((v) => ({ value: v, label: v }))] },
      },
      justify: {
        element: SELECT,
        data: { label: "Justify content", options: [{ value: "", label: "Default" }, ...Object.keys(JUSTIFY).map((v) => ({ value: v, label: v }))] },
      },
      gap: {
        element: SELECT,
        data: { label: "Gap", options: [{ value: "", label: "Default" }, ...Object.keys(GAP).map((v) => ({ value: v, label: v }))] },
      },
    },
  },
];
