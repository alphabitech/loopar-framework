import { createContext, useContext, useId, useMemo } from "react";
import { Droppable } from "@droppable";
import { cn } from "@cn/lib/utils";
import { isOn } from "./base/content-lines.js";

const AccordionContext = createContext({ group: null });
export const useAccordion = () => useContext(AccordionContext);

/** FAQPage structured data from the items' question (title) and answer (text). */
function faqSchema(elements = []) {
  const entities = elements
    .filter((el) => el?.element === "accordion_item" && el.data?.title && el.data?.text)
    .map((el) => ({
      "@type": "Question",
      name: el.data.title,
      acceptedAnswer: { "@type": "Answer", text: el.data.text },
    }));
  return entities.length ? { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: entities } : null;
}

/**
 * Collapsible items (FAQ, details). Built on <details>/<summary>, so it works
 * without JS and its content is indexable. `single` keeps one item open at
 * a time (shared `name` on the <details>).
 */
export default function Accordion(props) {
  const data = props.data || {};
  const id = useId();
  const group = isOn(data.single) ? `accordion-${(props.node || id).replace(/[^a-zA-Z0-9_-]/g, "")}` : null;
  const schema = useMemo(() => (isOn(data.faq_schema) ? faqSchema(props.elements) : null), [data.faq_schema, props.elements]);

  return (
    <AccordionContext.Provider value={{ group }}>
      <Droppable {...props} className={cn("divide-y divide-border rounded-xl border", props.className, "space-y-0 gap-0")} />
      {schema && (
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(schema).replace(/</g, "\\u003c") }} />
      )}
    </AccordionContext.Provider>
  );
}

Accordion.dontHaveMetaElements = ["text"];

Accordion.metaFields = () => [
  {
    group: "custom",
    elements: {
      single: { element: SWITCH, data: { label: "One Open at a Time" } },
      faq_schema: {
        element: SWITCH,
        data: {
          label: "FAQ Structured Data",
          description: "Publishes the items as a Google FAQ (FAQPage JSON-LD). Uses each item's question and answer text.",
        },
      },
    },
  },
];
