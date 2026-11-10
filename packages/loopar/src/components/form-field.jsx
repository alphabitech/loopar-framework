import { useMemo } from "react";
import MetaSelect from "./select.jsx";
import { useElementEditor } from "@context/element-editor-context";
import { elementsDict } from "@global/element-definition";

/** Elements whose value is one choice: what a cascade can depend on. */
const DISCRETE = new Set(["select", "radio_group", "connection", "switch", "checkbox"]);

/**
 * Element Editor only: a field of the form being designed (named, stored),
 * the edited element left out. `kinds`: "discrete" (default) or "all".
 */
export default function MetaFormField(props) {
  const editor = useElementEditor();
  const kinds = props.data?.kinds || "discrete";

  const options = useMemo(() => {
    const out = [];
    const walk = (nodes) => {
      for (const node of nodes || []) {
        const data = node.data || {};
        const own = (node.node ?? data.key) === editor?.elementKey;
        const writable = elementsDict[node.element]?.def?.isWritable;
        if (!own && writable && data.name && node.element !== "form_table" &&
          (kinds === "all" || DISCRETE.has(node.element)) &&
          !(node.element === "connection" && [1, "1", true, "true"].includes(data.multiple))) {
          out.push(`${data.name}:${data.label || data.name}`);
        }
        // A child table's fields belong to another entity.
        if (node.element !== "form_table") walk(node.elements);
      }
    };
    walk(editor?.metaTree);
    return [...new Set(out)].join("\n");
  }, [editor?.metaTree, editor?.elementKey, kinds]);

  return <MetaSelect {...props} data={{ ...props.data, options }} />;
}

MetaFormField.metaFields = () => [];
