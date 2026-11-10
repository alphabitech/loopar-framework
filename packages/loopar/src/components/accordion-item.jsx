import { ChevronDown } from "lucide-react";
import { Droppable } from "@droppable";
import { useDesigner } from "@context/designer-context";
import { cn } from "@cn/lib/utils";
import { useAccordion } from "@accordion";
import { isOn } from "./base/content-lines.js";

/**
 * One question/answer of an accordion: `title` is the question, `text` the
 * plain answer (used for
 * the FAQ structured data); extra blocks can be dropped below it.
 */
export default function AccordionItem(props) {
  const { designing } = useDesigner();
  const { group } = useAccordion();
  const data = props.data || {};

  return (
    <details
      className={cn("group px-4 [&_summary::-webkit-details-marker]:hidden", props.className)}
      style={props.style}
      {...(group && !designing ? { name: group } : {})}
      {...(designing || isOn(data.open) ? { open: true } : {})}
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-4 font-medium">
        <span>{data.title || "Question"}</span>
        <ChevronDown className="size-4 shrink-0 transition-transform duration-200 group-open:rotate-180" />
      </summary>
      <div className="pb-4 text-muted-foreground">
        {data.text && <p className="whitespace-pre-line text-pretty">{data.text}</p>}
        <Droppable {...props} className="space-y-4" />
      </div>
    </details>
  );
}

AccordionItem.metaFields = () => [
  {
    group: "custom",
    elements: {
      open: { element: SWITCH, data: { label: "Open by Default" } },
    },
  },
];
