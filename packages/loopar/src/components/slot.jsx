import { useViewOptions } from "@loopar/document";
import { useDesigner } from "@context/designer-context";
import { Plug } from "lucide-react";
import { __ } from "@global/i18n";

export default function MetaSlot(props) {
  const data = props.data || {};
  const ref = data?.name;
  const { slots } = useViewOptions();
  const { designerMode: isDesigner } = useDesigner();

  if (isDesigner) {
    return (
      <div style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 12px",
        border: "1.5px dashed var(--color-border-secondary)",
        borderRadius: "var(--border-radius-md)",
        background: "var(--color-background-secondary)",
        width: "100%",
        boxSizing: "border-box"
      }}>
        <Plug size={14} style={{ flexShrink: 0, color: "var(--color-text-secondary)" }} />
        <span style={{ fontSize: 12, color: "var(--color-text-secondary)", fontFamily: "var(--font-mono)" }}>
          {__("slot:")} <strong style={{ color: "var(--color-text-primary)", fontWeight: 500 }}>{ref}</strong>
        </span>
        <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--color-text-tertiary)", whiteSpace: "nowrap" }}>
          {__("runtime only")}
        </span>
      </div>
    );
  }

  const Comp = slots?.[ref];
  if (!Comp) return null;

  return <Comp {...props} />;
}

MetaSlot.metaFields = () => [{
  group: "form",
  elements: {
    name: { element: INPUT, data: { label: "Slot name", description: "Key of the component the view provides for this slot (useViewOptions slots)." } },
    writable: { element: SWITCH, data: { label: "Stores a value", description: "Creates a column so the slot's component can save a value with the record." } },
  },
}];
