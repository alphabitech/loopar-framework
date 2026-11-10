import { Droppable } from "@droppable";
import { Button } from "@cn/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@cn/components/ui/dialog";
import { useDesigner } from "@context/designer-context";
import { DynamicIcon } from "@icon";
import { VARIANTS } from "./base/ComponentDefaults";
import { rootProps } from "./base/root-props.js";
import { cn } from "@cn/lib/utils";

const WIDTH = { sm: "sm:max-w-sm", md: "sm:max-w-lg", lg: "sm:max-w-2xl", xl: "sm:max-w-4xl" };

/**
 * A button that opens a dialog with any content dropped inside (a form, a
 * video, terms…). While designing, the content is shown inline below the
 * trigger so it can be edited.
 */
export default function Modal(props) {
  const { designerMode } = useDesigner();
  const data = props.data || {};
  const trigger = (
    <Button type="button" variant={VARIANTS[data.trigger_variant] || VARIANTS.default}>
      {data.trigger_icon && <DynamicIcon icon={{ value: data.trigger_icon }} className="size-4" />}
      {data.trigger_label || "Open"}
    </Button>
  );

  if (designerMode) {
    return (
      <div {...rootProps(props)} className={cn("space-y-3", props.className)}>
        {trigger}
        <div className="rounded-lg border border-dashed p-4">
          {data.title && <h3 className="text-lg font-semibold">{data.title}</h3>}
          {data.description && <p className="text-sm text-muted-foreground">{data.description}</p>}
          <Droppable {...props} className="min-h-16" />
        </div>
      </div>
    );
  }

  return (
    <div {...rootProps(props)}>
      <Dialog>
        <DialogTrigger asChild>{trigger}</DialogTrigger>
        <DialogContent className={cn("max-h-[90vh] overflow-y-auto", WIDTH[data.width] || WIDTH.md)}>
          {(data.title || data.description) && (
            <DialogHeader>
              {data.title && <DialogTitle>{data.title}</DialogTitle>}
              {data.description && <DialogDescription>{data.description}</DialogDescription>}
            </DialogHeader>
          )}
          <Droppable {...props} className="space-y-4" />
        </DialogContent>
      </Dialog>
    </div>
  );
}

Modal.metaFields = () => [
  {
    group: "custom",
    elements: {
      trigger_variant: {
        element: SELECT,
        data: { label: "Button style", options: Object.keys(VARIANTS).map((k) => ({ value: VARIANTS[k], label: k })) },
      },
      trigger_icon: { element: ICON_INPUT, data: { label: "Button icon" } },
      width: {
        element: SELECT,
        data: { label: "Width", options: [{ value: "sm", label: "Small" }, { value: "md", label: "Medium" }, { value: "lg", label: "Large" }, { value: "xl", label: "Extra large" }], selected: "md" },
      },
    },
  },
];
