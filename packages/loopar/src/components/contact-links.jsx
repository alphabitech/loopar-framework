import { Phone, Mail, MapPin, Globe } from "lucide-react";
import SiWhatsapp from "@icons-pack/react-simple-icons/icons/SiWhatsapp.mjs";
import SiFacebook from "@icons-pack/react-simple-icons/icons/SiFacebook.mjs";
import SiInstagram from "@icons-pack/react-simple-icons/icons/SiInstagram.mjs";
import SiTiktok from "@icons-pack/react-simple-icons/icons/SiTiktok.mjs";
import SiYoutube from "@icons-pack/react-simple-icons/icons/SiYoutube.mjs";
import SiX from "@icons-pack/react-simple-icons/icons/SiX.mjs";
import { useDesigner } from "@context/designer-context";
import { cn } from "@cn/lib/utils";
import { __ } from "@global/i18n";
import { rootProps } from "./base/content-lines.js";
import { telUrl, whatsappUrl, mapsUrl, absoluteUrl } from "./base/contact-urls.js";

/** Display order; `contact` entries show their value, `social` ones only the icon in "icons" layout. */
const CHANNELS = [
  { key: "phone", Icon: Phone, href: (d) => telUrl(d.phone), text: (d) => d.phone, kind: "contact" },
  { key: "whatsapp", Icon: SiWhatsapp, href: (d) => whatsappUrl(d.whatsapp), text: () => "WhatsApp", kind: "contact" },
  { key: "email", Icon: Mail, href: (d) => (d.email ? `mailto:${d.email}` : null), text: (d) => d.email, kind: "contact" },
  { key: "address", Icon: MapPin, href: (d) => absoluteUrl(d.maps_url) || mapsUrl(d.address), text: (d) => d.address, kind: "contact", external: true },
  { key: "website", Icon: Globe, href: (d) => absoluteUrl(d.website), text: (d) => String(d.website || "").replace(/^https?:\/\//, ""), kind: "social" },
  { key: "facebook", Icon: SiFacebook, href: (d) => absoluteUrl(d.facebook), text: () => "Facebook", kind: "social" },
  { key: "instagram", Icon: SiInstagram, href: (d) => absoluteUrl(d.instagram), text: () => "Instagram", kind: "social" },
  { key: "tiktok", Icon: SiTiktok, href: (d) => absoluteUrl(d.tiktok), text: () => "TikTok", kind: "social" },
  { key: "youtube", Icon: SiYoutube, href: (d) => absoluteUrl(d.youtube), text: () => "YouTube", kind: "social" },
  { key: "x", Icon: SiX, href: (d) => absoluteUrl(d.x), text: () => "X", kind: "social" },
];

/**
 * Click-to-call phone, WhatsApp, email, address (opens Maps) and social
 * profiles. Layouts: list (stacked with text), inline (one row with text),
 * icons (round icon buttons).
 */
export default function ContactLinks(props) {
  const { designing } = useDesigner();
  const data = props.data || {};
  const layout = ["inline", "icons"].includes(data.layout) ? data.layout : "list";

  const links = CHANNELS.map((c) => ({ ...c, url: c.href(data) })).filter((c) => c.url);

  if (!links.length) {
    return designing ? (
      <div {...rootProps(props)}>
        <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">{__("Add a phone, email or social profile")}</p>
      </div>
    ) : null;
  }

  const outside = (c) => c.external || c.kind === "social" || c.key === "whatsapp";

  return (
    <div {...rootProps(props)}>
      <ul
        className={cn(
          layout === "list" && "space-y-3",
          layout === "inline" && "flex flex-wrap items-center gap-x-6 gap-y-3",
          layout === "icons" && "flex flex-wrap items-center gap-3"
        )}
      >
        {links.map(({ key, Icon, url, text }) => {
          const c = CHANNELS.find((x) => x.key === key);
          const label = text(data);
          return (
            <li key={key}>
              <a
                href={url}
                {...(outside(c) ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                aria-label={label}
                title={layout === "icons" ? label : undefined}
                className={cn(
                  "transition-colors",
                  layout === "icons"
                    ? "flex size-10 items-center justify-center rounded-full bg-secondary text-secondary-foreground hover:bg-primary hover:text-primary-foreground"
                    : "inline-flex items-center gap-3 hover:text-primary"
                )}
              >
                <Icon className={cn("shrink-0", layout === "icons" ? "size-5" : "size-5 text-primary")} />
                {layout !== "icons" && <span className="break-words">{label}</span>}
              </a>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

ContactLinks.dontHaveMetaElements = ["text", "label"];

ContactLinks.metaFields = () => [
  {
    group: "custom",
    elements: {
      layout: {
        element: SELECT,
        data: {
          label: "Layout",
          options: [{ value: "list", label: "List" }, { value: "inline", label: "Inline" }, { value: "icons", label: "Icons only" }],
        },
      },
      phone: { element: INPUT, data: { label: "Phone", description: "With country code, e.g. +1 617 555 0100." } },
      whatsapp: { element: INPUT, data: { label: "WhatsApp Number", description: "With country code." } },
      email: { element: INPUT, data: { label: "Email" } },
      address: { element: INPUT, data: { label: "Address" } },
      maps_url: { element: INPUT, data: { label: "Maps Link", description: "Optional. Defaults to a Google Maps search of the address." } },
      website: { element: INPUT, data: { label: "Website" } },
      facebook: { element: INPUT, data: { label: "Facebook URL" } },
      instagram: { element: INPUT, data: { label: "Instagram URL" } },
      tiktok: { element: INPUT, data: { label: "TikTok URL" } },
      youtube: { element: INPUT, data: { label: "YouTube URL" } },
      x: { element: INPUT, data: { label: "X URL" } },
    },
  },
];
