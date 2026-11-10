import { useMemo, useState } from "react";
import { ChevronsLeftRight } from "lucide-react";
import fileManager from "@@file/file-manager";
import { cn } from "@cn/lib/utils";
import { __ } from "@global/i18n";
import { rootProps } from "./base/content-lines.js";

const RATIOS = ["16:9", "4:3", "1:1", "3:4"];
const srcOf = (value) => fileManager.getMappedFiles(value)[0]?.src || null;

/**
 * Before/after comparison: the "before" image is clipped over the "after"
 * one and a native range input drives the split, so it works with mouse,
 * touch and keyboard without any library.
 */
export default function BeforeAfter(props) {
  const data = props.data || {};
  const [position, setPosition] = useState(() => {
    const p = parseInt(data.position, 10);
    return Number.isNaN(p) ? 50 : Math.min(100, Math.max(0, p));
  });

  const before = useMemo(() => srcOf(data.before_image), [data.before_image]);
  const after = useMemo(() => srcOf(data.after_image), [data.after_image]);
  const [w, h] = (RATIOS.includes(data.aspect_ratio) ? data.aspect_ratio : "16:9").split(":").map(Number);

  const label = "pointer-events-none absolute top-3 rounded-md bg-black/60 px-2 py-1 text-xs font-medium uppercase tracking-wide text-white";

  return (
    <div {...rootProps(props)}>
      <div
        className="relative w-full select-none overflow-hidden rounded-xl bg-muted"
        style={{ aspectRatio: `${w} / ${h}` }}
      >
        {after && <img src={after} alt={data.after_label || __("After")} loading="lazy" className="absolute inset-0 h-full w-full object-cover" />}
        {before && (
          <img
            src={before}
            alt={data.before_label || __("Before")}
            loading="lazy"
            className="absolute inset-0 h-full w-full object-cover"
            style={{ clipPath: `inset(0 ${100 - position}% 0 0)` }}
          />
        )}

        <span className={cn(label, "left-3")}>{data.before_label || __("Before")}</span>
        <span className={cn(label, "right-3")}>{data.after_label || __("After")}</span>

        <div className="pointer-events-none absolute inset-y-0 w-0.5 bg-white shadow" style={{ left: `${position}%` }}>
          <span className="absolute left-1/2 top-1/2 flex size-9 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white text-black shadow-lg">
            <ChevronsLeftRight className="size-5" />
          </span>
        </div>

        <input
          type="range"
          min="0"
          max="100"
          value={position}
          onChange={(e) => setPosition(Number(e.target.value))}
          aria-label={__("Drag to compare before and after")}
          className="absolute inset-0 h-full w-full cursor-ew-resize opacity-0"
        />
      </div>
    </div>
  );
}

BeforeAfter.dontHaveMetaElements = ["text", "background_image"];

BeforeAfter.metaFields = () => [
  {
    group: "custom",
    elements: {
      before_image: { element: IMAGE_INPUT, data: { label: "Before Image", accept: "image/*" } },
      after_image: { element: IMAGE_INPUT, data: { label: "After Image", accept: "image/*" } },
      before_label: { element: INPUT, data: { label: "Before Label", placeholder: "Before" } },
      after_label: { element: INPUT, data: { label: "After Label", placeholder: "After" } },
      position: { element: INPUT, data: { label: "Initial Position (%)", format: "number", default_value: 50 } },
      aspect_ratio: {
        element: SELECT,
        data: { label: "Aspect Ratio", options: RATIOS.map((r) => ({ value: r, label: r })), selected: "16:9" },
      },
    },
  },
];
