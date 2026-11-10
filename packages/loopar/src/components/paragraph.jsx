import BaseText from "@base-text";
import { useDesigner } from "@context/designer-context";
import { ComponentDefaults } from "./base/ComponentDefaults.jsx";
import { cn } from "@cn/lib/utils";
import { rootProps } from "./base/root-props.js";

const ALIGN = { left: "text-left", center: "text-center", right: "text-right", justify: "text-justify" };
const SIZE = { sm: "text-sm", md: "text-base", lg: "text-lg", xl: "text-xl" };

/** Body text. Inline-editable in the designer; `size` and `text_align` style it. */
export function Paragraph({ className, style, size, align, editable, onEdit, children, ...rest }) {
  return (
    <p
      {...rest}
      className={cn("mb-4 text-pretty text-foreground/80", SIZE[size] || SIZE.md, ALIGN[align] || "", className)}
      style={style}
      {...(editable ? {
        contentEditable: true,
        suppressContentEditableWarning: true,
        onBlur: (e) => onEdit?.(e.target.innerText),
        className: cn("cursor-text mb-4 text-pretty text-foreground/80", SIZE[size] || SIZE.md, ALIGN[align] || "", className),
      } : {})}
    >
      {children}
    </p>
  );
}

export default function MetaParagraph(props) {
  const { designerMode, designing } = useDesigner();
  const { set, data } = ComponentDefaults(props);
  const { getText } = BaseText(props);
  const editing = designerMode && designing;

  return (
    <Paragraph
      {...rootProps(props)}
      size={data.size}
      align={data.text_align}
      editable={editing}
      onEdit={(text) => set("text", text)}
      style={editing ? { ...(props.style || {}), maxHeight: "6em", overflow: "auto" } : props.style}
    >
      {getText()}
    </Paragraph>
  );
}

MetaParagraph.metaFields = () => [
  {
    group: "custom",
    elements: {
      size: {
        element: SELECT,
        data: {
          label: "Size",
          options: [{ value: "sm", label: "Small" }, { value: "md", label: "Medium" }, { value: "lg", label: "Large" }, { value: "xl", label: "Extra Large" }],
          selected: "md",
        },
      },
    },
  },
];
