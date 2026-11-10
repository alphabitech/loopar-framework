import { useState, useMemo } from "react";
import {ImageIcon} from "lucide-react";
import { cn } from "@cn/lib/utils";
import fileManager from "@@file/file-manager";
import { rootProps } from "./base/root-props.js";

const OBJECT_FIT = { cover: "object-cover", contain: "object-contain", auto: "object-none" };

/**
 * A real <img> (alt text, native lazy loading, indexable) inside a box that
 * keeps the aspect ratio, so the layout never shifts while it loads. Shows a
 * placeholder icon when the source is missing or broken.
 */
export function FallbackImage(props) {
  const { coverProps = {}, imageProps = {}, data = {}, root = {} } = props;
  const src = imageProps.src;
  // Keyed by src: picking another image clears a previous failure.
  const [failedSrc, setFailedSrc] = useState(null);
  const failed = failedSrc === src;

  const aspectRatio = useMemo(() => {
    if (data.aspect_ratio) {
      const [w = 1, h = 1] = String(data.aspect_ratio).split(":").map(Number);
      return (h / w) * 100;
    }
    return 60;
  }, [data.aspect_ratio]);

  const { backgroundColor } = coverProps.style || {};

  return (
    <div
      {...root}
      className={cn("relative w-full h-full overflow-hidden", root.className)}
      style={{ ...(root.style || {}), paddingTop: `${aspectRatio}%`, ...(backgroundColor ? { backgroundColor } : {}) }}
    >
      {src && !failed && (
        <img
          src={src}
          alt={imageProps.alt || ""}
          {...(imageProps.title ? { title: imageProps.title } : {})}
          loading={data.eager ? "eager" : "lazy"}
          decoding="async"
          onError={() => setFailedSrc(src)}
          className={cn(
            "absolute inset-0 w-full h-full",
            OBJECT_FIT[data.background_size] || OBJECT_FIT.cover,
          )}
          style={{ objectPosition: data.background_position || "center" }}
        />
      )}
      {(!src || failed) && (
        <ImageIcon
          className="absolute inset-0 h-full w-full opacity-10 border-primary/70 rounded"
          aria-hidden="true"
        />
      )}
    </div>
  );
}

export default function MetaImage(props) {
  const src = useMemo(
    () => fileManager.getMappedFiles(props.data?.background_image)[0]?.src || null,
    [props.data?.background_image]
  );

  return (
    <FallbackImage {...props} root={rootProps(props)} imageProps={{ src, ...(props.imageProps || {}) }} />
  )
}

MetaImage.metaFields = () => {
  return [[
    {
      group: "custom",
      elements: {
        aspect_ratio: {
          element: SELECT,
          data: {
            options: [
              { option: "1:1", value: "1:1" },
              { option: "4:3", value: "4:3" },
              { option: "16:9", value: "16:9" },
              { option: "21:9", value: "21:9" },
              { option: "3:4", value: "3:4" },
              { option: "9:16", value: "9:16" },
              { option: "9:21", value: "9:21" },
            ],
            default: "16:9",
          },
        },
      },
    },
    {
      group: "general",
      elements: {
        background_image: {
          element: IMAGE_INPUT,
          data: { 
            accept: "image/*",
          }
        },
        alt: {
          element: INPUT,
          data: {
            label: "Alt Text",
            description: "Describes the image for search engines and screen readers. Falls back to the label.",
          },
        },
        eager: {
          element: SWITCH,
          data: {
            label: "Load Immediately",
            description: "Turn on for the main image above the fold (hero); others load lazily.",
          },
        },
      }
    }
  ]];
}