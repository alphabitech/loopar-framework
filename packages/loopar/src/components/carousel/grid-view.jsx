import { useState, useEffect, useRef } from "react";
import { PlusIcon, Maximize2Icon, Loader2 } from "lucide-react";
import { Droppable } from "@droppable";
import { Button } from "@cn/components/ui/button";
import { getSlideThumbnail } from "./utils.js";
import { __ } from "@global/i18n";

export const GRID_LAYOUTS = ["uniform", "masonry", "quilted"];

const GRID_COLUMN_CLASSES = {
  "2": "grid-cols-1 sm:grid-cols-2",
  "3": "grid-cols-2 md:grid-cols-3",
  "4": "grid-cols-2 md:grid-cols-3 lg:grid-cols-4",
  "5": "grid-cols-2 md:grid-cols-3 lg:grid-cols-5",
};

const QUILTED_COLUMN_CLASSES = {
  "2": "grid-cols-2",
  "3": "grid-cols-3",
  "4": "grid-cols-2 md:grid-cols-4",
  "5": "grid-cols-3 md:grid-cols-5",
};

// The grid pattern OWNS the cell sizes; images adapt to their container
// (object-cover crop). Containers never resize to match the image — that
// inversion (the removed auto_ratio feature) made cells re-measure and
// reflow as each image loaded, on both SSR hydration and infinite scroll.
const MASONRY_RATIOS = ["72%", "100%", "133%", "86%", "115%", "64%"];
const QUILTED_SPANS = [
  "md:col-span-2 md:row-span-2",
  "",
  "md:row-span-2",
  "",
  "md:col-span-2",
  "",
  "md:row-span-2",
  "",
];

/**
 * Tracks whether the cell's image is ready so the content can fade in
 * instead of popping. Probes via Image() (shares the browser cache with
 * the real render, so nothing downloads twice); cached images resolve
 * synchronously through `img.complete` and skip the fade entirely.
 * `enabled: false` (designer, or cells without an image) reports ready
 * immediately.
 */
function useImageReady(src, enabled = true) {
  const [state, setState] = useState(() => ({ ready: !enabled || !src, failed: false }));

  useEffect(() => {
    if (!enabled || !src || typeof window === "undefined") return;
    let cancelled = false;
    const img = new window.Image();
    const done = (failed) => {
      if (cancelled) return;
      if (failed) console.warn("[gallery] dead image link:", src);
      setState({ ready: true, failed });
    };
    img.onload = () => done(false);
    img.onerror = () => done(true);
    img.src = src;
    if (img.complete) done(img.naturalWidth === 0);
    return () => { cancelled = true; };
  }, [src, enabled]);

  return state;
}

const DOWN_KEYS = new Set(["ArrowDown", "PageDown", "End", " ", "Spacebar"]);
const UP_KEYS = new Set(["ArrowUp", "PageUp", "Home"]);

function isTyping(t) {
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
}

function useInfiniteScroll({ hasMore, onLoadMore, isLoadingMore }) {
  const sentinelRef = useRef(null);
  const s = useRef({ interacted: false, intersecting: false, scrollReady: false });
  const loadingRef = useRef(isLoadingMore);
  loadingRef.current = isLoadingMore;
  const onLoadMoreRef = useRef(onLoadMore);
  onLoadMoreRef.current = onLoadMore;

  useEffect(() => {
    const t = setTimeout(() => { s.current.scrollReady = true; }, 600);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (!hasMore || typeof window === "undefined") return;
    const el = sentinelRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const st = s.current;

    const maybeLoad = () => {
      if (st.interacted && st.intersecting && !loadingRef.current) {
        st.interacted = false;
        onLoadMoreRef.current?.();
      }
    };

    const observer = new IntersectionObserver(
      (entries) => { st.intersecting = entries[0].isIntersecting; maybeLoad(); },
      { rootMargin: "200px", threshold: 0 }
    );
    observer.observe(el);

    const mark = () => { st.interacted = true; maybeLoad(); };
    const onScroll = () => { if (st.scrollReady) mark(); };
    const onKeyDown = (e) => { if (!isTyping(e.target) && DOWN_KEYS.has(e.key)) mark(); };

    window.addEventListener("wheel", mark, { passive: true });
    window.addEventListener("touchmove", mark, { passive: true });
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("keydown", onKeyDown);

    return () => {
      observer.disconnect();
      window.removeEventListener("wheel", mark);
      window.removeEventListener("touchmove", mark);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [hasMore]);

  return sentinelRef;
}

function useReverseScrollIntent({ hasPrev, onLoadPrev, isLoadingPrev, threshold = 40, atTopPx = 2 }) {
  const acc = useRef(0);
  const touchY = useRef(null);

  useEffect(() => {
    if (!hasPrev || !onLoadPrev || typeof window === "undefined") return;

    const atTop = () => window.scrollY <= atTopPx;
    const trigger = () => { if (!isLoadingPrev) onLoadPrev(); };

    const onWheel = (e) => {
      if (e.deltaY >= 0 || !atTop()) { acc.current = 0; return; }
      acc.current += -e.deltaY;
      if (acc.current >= threshold) { acc.current = 0; trigger(); }
    };
    const onTouchStart = (e) => { touchY.current = e.touches[0].clientY; };
    const onTouchMove = (e) => {
      if (touchY.current == null || !atTop()) return;
      const dy = e.touches[0].clientY - touchY.current;
      if (dy >= threshold) { touchY.current = null; trigger(); }
    };
    const onKeyDown = (e) => {
      if (!isTyping(e.target) && atTop() && UP_KEYS.has(e.key)) trigger();
    };

    window.addEventListener("wheel", onWheel, { passive: true });
    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: true });
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [hasPrev, onLoadPrev, isLoadingPrev, threshold, atTopPx]);
}

function GridCell({
  item,
  index: i,
  data,
  node,
  gridLayout,
  lightboxAvailable,
  designerMode,
  openLightbox,
}) {
  const { ready: imageReady, failed: imageFailed } = useImageReady(
    getSlideThumbnail(item),
    !designerMode
  );

  if (!item) return null;

  // A dead link would otherwise reserve its full cell (bg-card + aspect
  // ratio) forever. Collapse it instead — except in the designer, where the
  // author needs to see (and fix or remove) the broken slide.
  if (imageFailed && !designerMode) return null;

  const cellData = {
    ...item.data,
    isActive: true,
    static_content: data.static_content,
    background_color: item.data?.background_color || data.background_color,
    background_blend_mode: item.data?.background_blend_mode || data.background_blend_mode,
    node,
  };

  // The fade wrapper owns the absolute fill; the cell's bg-card acts as
  // the placeholder until the image is ready. Cached images mount with
  // opacity-100 directly (useImageReady resolves synchronously), so the
  // fade only plays when there was actually something to wait for.
  const inner = (
    <div
      className={`absolute inset-0 w-full h-full transition-opacity duration-700 ease-out ${
        imageReady ? "opacity-100" : "opacity-0"
      }`}
    >
      {item.$$typeof === Symbol.for("react.transitional.element") ? (
        item
      ) : (
        <Droppable
          className="absolute inset-0 w-full h-full"
          data={cellData}
          index={i}
          elements={[
            {
              ...item,
              element: item.element || "banner",
              data: cellData,
              haveCarousel: true,
              elements: item.elements,
            },
          ]}
        />
      )}
    </div>
  );

  // Deterministic, index-keyed sizing — identical on server and client,
  // independent of when (or whether) each image loads.
  let layoutClass = "";
  let cellStyle;
  if (gridLayout === "masonry") {
    // Spacing comes from the column wrapper's gap; the cell only sizes itself.
    cellStyle = { paddingTop: MASONRY_RATIOS[i % MASONRY_RATIOS.length] };
  } else if (gridLayout === "quilted") {
    layoutClass = QUILTED_SPANS[i % QUILTED_SPANS.length];
    cellStyle = undefined;
  } else {
    cellStyle = { paddingTop: data.cell_aspect_ratio || "75%" };
  }

  const bodyClickable = lightboxAvailable && !designerMode;
  return (
    <div
      className={`group relative w-full overflow-hidden rounded-xl bg-card ${layoutClass} ${bodyClickable ? "cursor-zoom-in" : ""}`}
      style={cellStyle}
      {...(bodyClickable
        ? {
            role: "button",
            tabIndex: 0,
            "aria-label": `Open item ${i + 1}`,
            onClick: (e) => { e.preventDefault(); openLightbox(i); },
            onKeyDown: (e) => {
              if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openLightbox(i); }
            },
          }
        : {})}
    >
      {inner}
      {bodyClickable ? (
        <span className="absolute inset-0 z-10 bg-black/0 transition-colors group-hover:bg-black/15 group-focus-visible:bg-black/15" />
      ) : null}
      {lightboxAvailable ? (
        <button
          type="button"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); openLightbox(i); }}
          className="absolute top-2 right-2 z-20 inline-flex items-center justify-center w-8 h-8 rounded-full bg-background/70 backdrop-blur text-foreground/80 hover:text-foreground hover:bg-background transition-all opacity-0 group-hover:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`Open item ${i + 1} fullscreen`}
        >
          <Maximize2Icon className="w-4 h-4" />
        </button>
      ) : null}
    </div>
  );
}

export default function GridView({
  items = [],
  data = {},
  //page,
  node,
  designerMode = false,
  lightboxAvailable = false,
  openLightbox,
  onLoadMore,
  hasMore = false,
  isLoadingMore = false,
  onLoadPrev,
  hasPrev = false,
  isLoadingPrev = false,
  addSlide,
}) {
  const gridLayout = GRID_LAYOUTS.includes(data.grid_layout) ? data.grid_layout : "uniform";
  const sentinelRef = useInfiniteScroll({
    hasMore,
    onLoadMore,
    isLoadingMore,
  });
  useReverseScrollIntent({ hasPrev, onLoadPrev, isLoadingPrev });

  const cols = String(data.grid_columns || "3");

  const renderCell = (item, i) => (
    <GridCell
      key={item?.node || `cell-${i}`}
      item={item}
      index={i}
      data={data}
      node={node}
      gridLayout={gridLayout}
      lightboxAvailable={lightboxAvailable}
      designerMode={designerMode}
      openLightbox={openLightbox}
    />
  );

  let gridNode;
  if (gridLayout === "masonry") {
    // Explicit round-robin columns instead of CSS multi-columns: assigning
    // by index (i % colCount) is deterministic on server and client, and
    // appended pages (infinite scroll) never re-balance existing cards.
    const colCount = Math.max(1, parseInt(cols, 10) || 3);
    const columns = Array.from({ length: colCount }, () => []);
    items.forEach((item, i) => columns[i % colCount].push([item, i]));
    gridNode = (
      <div className="flex gap-3 w-full items-start">
        {columns.map((column, c) => (
          <div key={`masonry-col-${c}`} className="flex-1 min-w-0 flex flex-col gap-3">
            {column.map(([item, i]) => renderCell(item, i))}
          </div>
        ))}
      </div>
    );
  } else if (gridLayout === "quilted") {
    gridNode = (
      <div
        className={`grid ${QUILTED_COLUMN_CLASSES[cols] || QUILTED_COLUMN_CLASSES["3"]} grid-flow-dense gap-3 w-full`}
        style={{ gridAutoRows: data.quilt_row_height || "11rem" }}
      >
        {items.map(renderCell)}
      </div>
    );
  } else {
    gridNode = (
      <div className={`grid ${GRID_COLUMN_CLASSES[cols] || GRID_COLUMN_CLASSES["3"]} gap-3 w-full`}>
        {items.map(renderCell)}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 w-full">
      {onLoadPrev && hasPrev ? (
        <button
          type="button"
          onClick={(e) => { e.preventDefault(); if (!isLoadingPrev) onLoadPrev(); }}
          disabled={isLoadingPrev}
          className="w-full py-2 flex items-center justify-center focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-md"
          style={{ minHeight: 32 }}
          aria-label={__("Load previous items")}
        >
          {isLoadingPrev ? (
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          ) : (
            <span className="text-xs text-muted-foreground hover:text-foreground">{__("↑ Load previous")}</span>
          )}
        </button>
      ) : null}
      {gridNode}
      {onLoadMore && hasMore ? (
        <div
          ref={sentinelRef}
          className="w-full py-4 flex items-center justify-center"
          style={{ minHeight: 40 }}
        >
          {isLoadingMore ? (
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          ) : (
            <span className="text-xs text-muted-foreground">{__("Scroll for more…")}</span>
          )}
        </div>
      ) : null}
      {designerMode && addSlide ? (
        <Button
          variant="secondary"
          size="sm"
          className="self-start h-8 px-3 bg-primary hover:bg-primary/90 text-primary-foreground shadow-lg"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); addSlide(); }}
        >
          <PlusIcon className="w-4 h-4 mr-1" />
          {__("Add Item")}
        </Button>
      ) : null}
    </div>
  );
}
