import { useDesigner } from "@context/designer-context";
import { cn } from "@cn/lib/utils";
import { __ } from "@global/i18n";
import { rootProps } from "./base/content-lines.js";

const RATIOS = { "16:9": "16 / 9", "4:3": "4 / 3", "1:1": "1 / 1", "21:9": "21 / 9" };

/** Google Maps embed for an address; no API key needed. */
const mapUrl = (address) => `https://www.google.com/maps?q=${encodeURIComponent(address)}&output=embed`;

/** Only absolute http(s) URLs are embedded. */
const safeUrl = (url) => {
  try {
    const u = new URL(String(url || "").trim());
    return ["http:", "https:"].includes(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
};

/**
 * Embeds an external page (booking widget, form, map…) in an iframe.
 * With `address` it renders a Google Map of that place instead of `url`.
 */
export default function Embed(props) {
  const { designing } = useDesigner();
  const data = props.data || {};
  const src = data.address ? mapUrl(data.address) : safeUrl(data.url);
  const height = parseInt(data.height, 10);
  const sizeStyle = height > 0 ? { height: `${height}px` } : { aspectRatio: RATIOS[data.aspect_ratio] || RATIOS["16:9"] };

  if (!src) {
    return designing ? (
      <div {...rootProps(props)}>
        <div className="flex items-center justify-center rounded-xl border border-dashed p-8 text-sm text-muted-foreground" style={sizeStyle}>
          {__("Set a URL or an address to embed")}
        </div>
      </div>
    ) : null;
  }

  return (
    <div {...rootProps(props)}>
      <iframe
        src={src}
        title={data.title || (data.address ? __("Map") : __("Embedded content"))}
        loading="lazy"
        referrerPolicy="no-referrer-when-downgrade"
        allowFullScreen
        className={cn("w-full rounded-xl border-0", designing && "pointer-events-none")}
        style={sizeStyle}
      />
    </div>
  );
}

Embed.dontHaveMetaElements = ["background_image"];

Embed.metaFields = () => [
  {
    group: "custom",
    elements: {
      url: { element: INPUT, data: { label: "URL", description: "Page to embed (https://…). Ignored when Address is set." } },
      address: { element: INPUT, data: { label: "Map Address", description: "Shows a Google Map of this address." } },
      aspect_ratio: {
        element: SELECT,
        data: { label: "Aspect Ratio", options: Object.keys(RATIOS).map((r) => ({ value: r, label: r })), selected: "16:9" },
      },
      height: { element: INPUT, data: { label: "Fixed Height (px)", format: "number", description: "Overrides the aspect ratio." } },
    },
  },
];
