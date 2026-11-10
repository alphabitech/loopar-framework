import { DynamicIcon } from "@icon";
import { useDesigner } from "@context/designer-context";
import { cn } from "@cn/lib/utils";
import { parseLines, isOn, rootProps } from "./base/content-lines.js";

const SAMPLE = "First item\nSecond item\nThird item";
const COLUMNS = { 1: "", 2: "sm:grid-cols-2", 3: "sm:grid-cols-2 lg:grid-cols-3" };

/** Bulleted, checked or numbered list — one item per line. */
export default function List(props) {
  const { designing } = useDesigner();
  const data = props.data || {};
  const items = parseLines(data.items || (designing ? SAMPLE : ""));
  if (!items.length) return null;

  const ordered = isOn(data.ordered);
  const Tag = ordered ? "ol" : "ul";
  const icon = data.icon || "Check";

  return (
    <div {...rootProps(props)}>
      <Tag className={cn("grid gap-x-8 gap-y-3", COLUMNS[data.columns] || "")}>
        {items.map(([text], i) => (
          <li key={i} className="flex items-start gap-3">
            {ordered ? (
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
                {i + 1}
              </span>
            ) : (
              <DynamicIcon icon={{ value: icon }} className="mt-0.5 size-5 shrink-0 text-primary" />
            )}
            <span className="text-pretty">{text}</span>
          </li>
        ))}
      </Tag>
    </div>
  );
}

List.dontHaveMetaElements = ["text"];

List.metaFields = () => [
  {
    group: "custom",
    elements: {
      items: {
        element: TEXTAREA,
        data: { label: "Items", description: "One item per line.", rows: 6 },
      },
      ordered: { element: SWITCH, data: { label: "Numbered" } },
      icon: { element: ICON_INPUT, data: { label: "Icon", description: "Bullet icon (default: Check)." } },
      columns: {
        element: SELECT,
        data: { label: "Columns", options: [{ value: "1", label: "1" }, { value: "2", label: "2" }, { value: "3", label: "3" }] },
      },
    },
  },
];
