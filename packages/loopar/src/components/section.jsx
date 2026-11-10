import { useEffect, useState, useMemo } from "react";
import { Droppable } from "@droppable";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { usePersist } from "@services/persist-state";
import { useDesigner } from "@context/designer-context";
import { useDocument } from "@loopar/document";
import { cn } from "@cn/lib/utils";
import { rootProps } from "./base/root-props.js";

const DEFAULTS = {
  gap: 4,
  padding_y: "md",
  full_width: false,
};

const MIN_HEIGHT = { half: "min-h-[50vh]", screen: "min-h-[calc(100vh-var(--spacing-web-header-height,0px))]" };
const CONTENT_ALIGN = { center: "justify-center", end: "justify-end" };
const VIDEO_OVERLAY = { light: "bg-black/20", medium: "bg-black/40", strong: "bg-black/60" };
// Background video: a direct file (.mp4/.webm). Streaming platforms belong in video_embed.
const VIDEO_FILE = /^https?:\/\/\S+\.(mp4|webm|ogv|mov)(\?\S*)?$/i;

export default function Section(props) {
  const { designing } = useDesigner();
  const [collapsible, setCollapsible] = useState(false);
  const { data = {}, node } = props;

  const [collapsed, setCollapsed] = usePersist(node, false);
  const { spacing: docSpacing = {} } = useDocument();

  const config = useMemo(() => ({
    ...DEFAULTS,
    ...data,
    gap: data.gap ?? docSpacing.gap ?? DEFAULTS.gap,
  }), [data, docSpacing]);

  // The collapse toggle is an editing aid: visitors never see it, and a
  // section collapsed while designing still renders on the public page.
  useEffect(() => {
    setCollapsible(!!designing);
  }, [designing]);

  const videoSrc = VIDEO_FILE.test(String(data.background_video || "").trim()) ? String(data.background_video).trim() : null;

  const gap = useMemo(() => {
    const sp = parseInt(config.gap);
    return Number.isNaN(sp) ? DEFAULTS.gap : sp;
  }, [config.gap]);

  const paddingY = useMemo(() => {
    return {
      none: "py-0",
      sm: "py-4 md:py-6 lg:py-8",
      md: "py-8 md:py-12 lg:py-24",
      lg: "py-12 md:py-16 lg:py-32",
      xl: "py-16 md:py-24 lg:py-40",
    }[config.padding_y] || "py-8 md:py-12 lg:py-24";
  }, [config.padding_y]);

  return (
    <div>
      <div className="absolute z-10 flex h-8 w-8">
        {collapsible && collapsed && (
          <ChevronDownIcon 
            className="h-4 w-4 cursor-pointer text-white" 
            onClick={() => setCollapsed(false)} 
          />
        )}
        {collapsible && !collapsed && (
          <ChevronUpIcon 
            className="h-4 w-4 cursor-pointer text-white" 
            onClick={() => setCollapsed(true)} 
          />
        )}
      </div>
      <div
        className={cn(
          !config.full_width && "container mx-auto",
          collapsible && collapsed && "h-10 overflow-hidden"
        )}
      >
        {!(collapsible && collapsed) && (
          <section
            {...rootProps(props)}
            className={cn(
              "mx-auto flex",
              !config.full_width && "max-w-[1280px]",
              "flex-col",
              paddingY,
              MIN_HEIGHT[config.min_height],
              CONTENT_ALIGN[config.content_align],
              videoSrc && "relative overflow-hidden",
              props.className
            )}
            style={{
              gap: `${gap}rem`,
              ...props.style,
            }}
          >
            {videoSrc && (
              <>
                <video
                  className="pointer-events-none absolute inset-0 -z-0 h-full w-full object-cover"
                  src={videoSrc}
                  autoPlay
                  muted
                  loop
                  playsInline
                  preload="metadata"
                  aria-hidden="true"
                />
                {config.video_overlay && config.video_overlay !== "none" && (
                  <div className={cn("pointer-events-none absolute inset-0", VIDEO_OVERLAY[config.video_overlay])} aria-hidden="true" />
                )}
              </>
            )}
            <Droppable
              {...props}
              className={cn("flex flex-col w-full p-4 lg:p-0", videoSrc && "relative z-10")}
              style={{ gap: `${gap}rem` }}
            />
          </section>
        )}
      </div>
    </div>
  );
}


Section.metaFields = () => {
  return [
    {
      group: "layout",
      elements: {
        gap: {
          element: SELECT,
          data: {
            label: "Gap",
            options: [0, 1, 2, 3, 4, 5, 6],
            selected: DEFAULTS.gap,
            description: "Gap between rows in rem.",
          },
        },
        padding_y: {
          element: SELECT,
          data: {
            label: "Vertical Padding",
            options: [
              { option: "none", value: "None" },
              { option: "sm", value: "Small" },
              { option: "md", value: "Medium" },
              { option: "lg", value: "Large" },
              { option: "xl", value: "Extra Large" },
            ],
            selected: DEFAULTS.padding_y,
          },
        },
        full_width: {
          element: SWITCH,
          data: {
            label: "Full Width",
            description: "Remove max-width constraint",
          },
        },
        min_height: {
          element: SELECT,
          data: {
            label: "Min Height",
            options: [{ value: "", label: "Content" }, { value: "half", label: "Half screen" }, { value: "screen", label: "Full screen" }],
          },
        },
        content_align: {
          element: SELECT,
          data: {
            label: "Vertical Align",
            description: "Where the content sits when the section is taller than it.",
            options: [{ value: "", label: "Top" }, { value: "center", label: "Center" }, { value: "end", label: "Bottom" }],
          },
        },
        background_video: {
          element: INPUT,
          data: { label: "Background Video", description: "URL of an .mp4/.webm file; plays muted in a loop behind the content." },
        },
        video_overlay: {
          element: SELECT,
          data: {
            label: "Video Overlay",
            options: [{ value: "none", label: "None" }, { value: "light", label: "Light" }, { value: "medium", label: "Medium" }, { value: "strong", label: "Strong" }],
          },
        },
      },
    },
  ];
};