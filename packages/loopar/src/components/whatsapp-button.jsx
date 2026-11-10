import SiWhatsapp from "@icons-pack/react-simple-icons/icons/SiWhatsapp.mjs";
import { useDesigner } from "@context/designer-context";
import { cn } from "@cn/lib/utils";
import { __ } from "@global/i18n";
import { isOn, rootProps } from "./base/content-lines.js";
import { whatsappUrl } from "./base/contact-urls.js";

/**
 * WhatsApp chat button, optionally floating in a corner of the page.
 * In the designer the floating button is shown inline so it can be edited.
 */
export default function WhatsappButton(props) {
  const { designerMode } = useDesigner();
  const data = props.data || {};
  const url = whatsappUrl(data.phone, data.message);
  const floating = data.floating === undefined || data.floating === "" ? true : isOn(data.floating);

  if (!url && !designerMode) return null;

  const label = data.label || __("Chat on WhatsApp");
  const fixed = floating && !designerMode;

  return (
    <div {...rootProps(props)} className={cn(!fixed && props.className)}>
      <a
        href={url || "#"}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={label}
        className={cn(
          "inline-flex items-center gap-2 rounded-full bg-[#25D366] font-medium text-white shadow-lg transition-transform hover:scale-105",
          floating ? "p-4" : "px-5 py-3",
          fixed && cn("fixed bottom-5 z-50", data.position === "left" ? "left-5" : "right-5")
        )}
      >
        <SiWhatsapp className="size-6" color="currentColor" />
        {!floating && <span>{label}</span>}
      </a>
    </div>
  );
}

WhatsappButton.dontHaveMetaElements = ["text"];

WhatsappButton.metaFields = () => [
  {
    group: "custom",
    elements: {
      phone: { element: INPUT, data: { label: "WhatsApp Number", description: "With country code, e.g. +504 9999 9999." } },
      message: { element: TEXTAREA, data: { label: "Prefilled Message", rows: 2 } },
      floating: { element: SWITCH, data: { label: "Floating", description: "Fixed in a bottom corner of every screen.", default_value: 1 } },
      position: {
        element: SELECT,
        data: { label: "Corner", options: [{ value: "right", label: "Bottom right" }, { value: "left", label: "Bottom left" }] },
      },
    },
  },
];
