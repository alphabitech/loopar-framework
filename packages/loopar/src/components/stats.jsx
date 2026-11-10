import { useEffect, useRef, useState } from "react";
import { useDesigner } from "@context/designer-context";
import { cn } from "@cn/lib/utils";
import { parseLines, rootProps } from "./base/content-lines.js";

const SAMPLE = "15+ | Years of experience\n300+ | Projects completed\n100% | Satisfaction guaranteed";
const NUMBER = /^(\D*?)(\d[\d,]*(?:\.\d+)?)(.*)$/;

/**
 * Counts a value like "300+" or "$1,200" up from zero when it scrolls into
 * view. The server (and anyone with reduced motion) gets the final value;
 * a stat already on screen at load is not animated, so nothing flickers.
 */
function CountUp({ value, animate }) {
  const ref = useRef(null);
  const [shown, setShown] = useState(value);

  useEffect(() => {
    setShown(value);
    const match = String(value).match(NUMBER);
    const el = ref.current;
    if (!animate || !match || !el || typeof IntersectionObserver === "undefined") return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    if (el.getBoundingClientRect().top < window.innerHeight) return;

    const [, prefix, raw, suffix] = match;
    const target = parseFloat(raw.replace(/,/g, ""));
    const decimals = (raw.split(".")[1] || "").length;
    const grouped = raw.includes(",");
    const format = (n) => prefix + (grouped
      ? n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
      : n.toFixed(decimals)) + suffix;

    setShown(format(0));
    let frame;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      observer.disconnect();
      const start = performance.now();
      const duration = 1500;
      const tick = (now) => {
        const t = Math.min(1, (now - start) / duration);
        const eased = 1 - Math.pow(1 - t, 3);
        setShown(t < 1 ? format(target * eased) : value);
        if (t < 1) frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    }, { threshold: 0.4 });
    observer.observe(el);

    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [value, animate]);

  return <span ref={ref} className="tabular-nums">{shown}</span>;
}

const COLUMNS = { 2: "sm:grid-cols-2", 3: "sm:grid-cols-3", 4: "sm:grid-cols-2 lg:grid-cols-4" };

/** Key figures ("300+ projects"): one per line, `Value | Label`. */
export default function Stats(props) {
  const { designing } = useDesigner();
  const data = props.data || {};
  const stats = parseLines(data.items || (designing ? SAMPLE : ""), 2);
  if (!stats.length) return null;

  const animate = !designing && data.count_up !== 0 && data.count_up !== "0" && data.count_up !== false;
  const columns = COLUMNS[data.columns] || COLUMNS[Math.min(4, Math.max(2, stats.length))] || COLUMNS[3];

  return (
    <div {...rootProps(props)}>
      <dl className={cn("grid gap-8 text-center", columns)}>
        {stats.map(([value, label], i) => (
          <div key={i} className="flex flex-col-reverse gap-1">
            <dt className="text-sm text-muted-foreground md:text-base">{label}</dt>
            <dd className="text-4xl font-bold tracking-tight text-primary md:text-5xl">
              <CountUp value={value} animate={animate} />
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

Stats.dontHaveMetaElements = ["text"];

Stats.metaFields = () => [
  {
    group: "custom",
    elements: {
      items: {
        element: TEXTAREA,
        data: { label: "Figures", description: "One per line: Value | Label (e.g. 300+ | Projects completed)", rows: 5 },
      },
      columns: {
        element: SELECT,
        data: { label: "Columns", options: [{ value: "", label: "Auto" }, { value: "2", label: "2" }, { value: "3", label: "3" }, { value: "4", label: "4" }] },
      },
      count_up: { element: SWITCH, data: { label: "Count Up Animation", default_value: 1 } },
    },
  },
];
