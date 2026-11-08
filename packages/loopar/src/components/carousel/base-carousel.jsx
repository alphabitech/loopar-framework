import { useState, useMemo, useCallback, useRef } from "react";
import loopar from "loopar";
import { useDesigner } from "@context/designer-context";
import { PlusIcon, Maximize2Icon } from "lucide-react";
import { Droppable } from "@droppable";
import { Button } from "@cn/components/ui/button";
import CarouselBase from "./carousel.jsx";
import GridView from "./grid-view.jsx";
import CarouselLightbox from "./lightbox.jsx";
import ThumbStrip from "./thumb-strip.jsx";
import ArrowButton from "./arrow-button.jsx";
import { makeContainerStyle } from "./utils.js";
import carouselMetaFields from "./meta-fields.js";
import { __ } from "@global/i18n";

const VIEW_MODES = ["slides", "gallery", "grid"];
const CONTENT_EXIT_DURATION = 300;

const BaseCarousel = (props) => {
  const { data = {}, node, elements, children, content, onLoadMore, hasMore = false, isLoadingMore = false, onLoadPrev, hasPrev = false, isLoadingPrev = false, page } = props;
  const { designerMode } = useDesigner();
  const [index, setIndex] = useState(() => {
    const fromData = data?._cookie_index;
    if (fromData != null && fromData !== "") {
      const n = parseInt(fromData, 10);
      if (!Number.isNaN(n)) return n;
    }
    const saved = loopar.cookie.get(node);
    const n = saved ? parseInt(saved, 10) : 0;
    return Number.isNaN(n) ? 0 : n;
  });

  const hasNavigatedRef = useRef(false);

  const handleChange = useCallback((next) => {
    hasNavigatedRef.current = true;
    setIndex(next);
    loopar.cookie.set(node, next);
  }, [node]);

  const [lightboxIndex, setLightboxIndex] = useState(null);
  const items = useMemo(() => children || elements || [], [children, elements]);
  const itemCount = items.length;
  const transitionDurationMs = parseInt(data.animation_duration, 10) || 500;
  const viewMode = VIEW_MODES.includes(data.view_mode) ? data.view_mode : "slides";
  const lightboxAvailable = loopar.utils.trueValue(data.lightbox);
  const openLightbox = useCallback((i) => {
    setLightboxIndex((prev) => (prev === i ? prev : i));
  }, []);
  const closeLightbox = useCallback(() => setLightboxIndex(null), []);

  if (!itemCount && !content) {
    return (
      <div
        className={`relative w-full overflow-hidden`}
        style={makeContainerStyle(data)}
      >
        <div className="absolute inset-0 flex items-center justify-center bg-muted/20">
          <p className="text-muted-foreground">{__("No slides available")}</p>
        </div>
      </div>
    );
  }

  const renderSlide = (item, ctx) => {
    if (!item) return null;
    if (item.$$typeof === Symbol.for("react.transitional.element")) {
      return ctx.isCurrent ? item : null;
    }

    if (designerMode) {
      if (!ctx.isCurrent) return null;
    } else {
      if (!ctx.isCurrent && !ctx.isPrev) return null;
    }

    const slideData = {
      ...item.data,
      ...(!ctx.isPrev && !designerMode && hasNavigatedRef.current ? {
        animation: data.animation,
        animation_duration: data.animation_duration,
        animation_delay: data.animation_delay,
      } : {}),
      isActive: ctx.isCurrent && !ctx.isExiting,
      static_content: data.static_content,
      background_color: item.data?.background_color || data.background_color,
      background_blend_mode: item.data?.background_blend_mode || data.background_blend_mode,
      text_background: loopar.utils.trueValue(data.text_background) ? 1 : item.data?.text_background,
      text_background_class: data.text_background_class || item.data?.text_background_class,
      content_animation: data.content_animation || item.data?.content_animation,
      is_prev_slide: ctx.isPrev ? 1 : 0,
      node,
    };

    return (
      <Droppable
        key={`${item.node || ctx.index}-${ctx.isPrev ? "prev" : "current"}`}
        className={`[grid-area:1/1] w-full ${ctx.isPrev ? "z-0" : "z-10"} ${designerMode ? "pt-3 overflow-x-acu" : ""}`}
        data={slideData}
        index={ctx.index}
        elements={[
          {
            ...item,
            element: item.element || "banner",
            data: slideData,
            haveCarousel: true,
            elements: item.elements,
          },
        ]}
      />
    );
  };

  const renderArrowLeft = ({ onClick, hovered }) =>
    data.arrows === false || itemCount <= 1 ? null : (
      <ArrowButton variant={viewMode} direction="left" onClick={onClick} hovered={hovered} />
    );

  const renderArrowRight = ({ onClick, hovered }) =>
    data.arrows === false || itemCount <= 1 ? null : (
      <ArrowButton variant={viewMode} direction="right" onClick={onClick} hovered={hovered} />
    );

  const renderIndicators = ({ current, count, goTo }) => {
    if (data.indicators === false || count <= 1) return null;
    const isGallery = viewMode === "gallery";
    return (
      <div className="absolute bottom-3 md:bottom-4 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1.5">
        {Array.from({ length: count }, (_, i) => {
          const active = i === current;
          const cls = isGallery
            ? `h-2 rounded-full transition-all ${
                active ? "bg-primary w-5" : "bg-background/70 hover:bg-background w-2"
              }`
            : `w-2.5 h-2.5 rounded-full transition-all duration-200 ${
                active ? "bg-white scale-110" : "bg-white/50 hover:bg-white/75"
              }`;
          return (
            <button
              key={`indicator-${i}`}
              type="button"
              className={`${cls} focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2`}
              onClick={(e) => { e.preventDefault(); goTo(i); }}
              aria-label={`Go to slide ${i + 1}`}
              aria-current={active ? "true" : "false"}
            />
          );
        })}
      </div>
    );
  };

  const renderCounter = ({ index: i, count }) =>
    viewMode === "gallery" && count > 1 && !designerMode ? (
      <div className="absolute top-2 right-2 z-20 text-xs px-2 py-1 rounded-md bg-background/70 text-foreground backdrop-blur">
        {i + 1} / {count}
      </div>
    ) : null;

  const renderBefore = (slots) => (
    <>
      {renderCounter(slots)}
      {designerMode ? (
        <div className="absolute bottom-4 left-4 z-30 flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            className="h-8 px-3 bg-primary hover:bg-primary/90 text-primary-foreground shadow-lg"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              props.addSlide?.();
              setTimeout(() => handleChange(Math.max(0, (elements || []).length)), 0);
            }}
          >
            <PlusIcon className="w-4 h-4 mr-1" />
            {__("Add Slide")}
          </Button>

          <div className="flex items-center gap-1 px-3 py-1.5 rounded-md bg-background/80 backdrop-blur-sm text-sm font-medium shadow-lg">
            <span className="text-foreground">{index + 1}</span>
            <span className="text-muted-foreground">/</span>
            <span className="text-muted-foreground">{itemCount || 0}</span>
          </div>
        </div>
      ) : null}
    </>
  );

  const showThumbs = viewMode === "gallery" && itemCount > 1 && data.thumbs !== false;

  const carouselNode = (
    <div
      className={`relative w-full ${designerMode ? "overflow-visible" : "overflow-hidden"} ${viewMode === "gallery" ? " bg-card" : ""} ${data.touch && !designerMode ? "cursor-grab active:cursor-grabbing" : ""}`}
    >
      {content ? (
        <div className="w-full" style={makeContainerStyle(data)}>{content}</div>
      ) : (
        <CarouselBase
          slides={items}
          renderSlide={renderSlide}
          renderArrowLeft={renderArrowLeft}
          renderArrowRight={renderArrowRight}
          renderIndicators={renderIndicators}
          renderBefore={renderBefore}
          current={index}
          onChange={handleChange}
          autoplay={!designerMode && (data.autoplay == null ? true : loopar.utils.trueValue(data.autoplay))}
          intervalMs={(parseInt(data.interval, 10) || 5) * 1000}
          pauseOnHover={data.pause == null ? true : loopar.utils.trueValue(data.pause)}
          loop={data.loop !== false}
          keyboard={!!data.keyboard && !designerMode}
          touch={!!data.touch && !designerMode}
          exitDurationMs={CONTENT_EXIT_DURATION}
          transitionDurationMs={transitionDurationMs}
          containerClassName="grid grid-cols-1 [grid-template-rows:1fr] w-full select-none group"
          containerStyle={makeContainerStyle(data)}
        />
      )}

      {lightboxAvailable ? (
        <button
          type="button"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); openLightbox(index); }}
          className="absolute top-2 left-2 z-30 inline-flex items-center justify-center w-9 h-9 rounded-full bg-background/70 backdrop-blur text-foreground/80 hover:text-foreground hover:bg-background transition-all opacity-0 hover:opacity-100 group-hover:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={__("Open fullscreen")}
        >
          <Maximize2Icon className="w-4 h-4" />
        </button>
      ) : null}
    </div>
  );

  const lightboxNode = lightboxAvailable ? (
    <CarouselLightbox
      open={lightboxIndex != null}
      index={lightboxIndex}
      onChange={setLightboxIndex}
      onClose={closeLightbox}
      slides={items}
      renderSlide={renderSlide}
      renderArrowLeft={renderArrowLeft}
      renderArrowRight={renderArrowRight}
      renderIndicators={renderIndicators}
      loop={data.loop !== false}
      exitDurationMs={CONTENT_EXIT_DURATION}
      transitionDurationMs={transitionDurationMs}
    />
  ) : null

  if (viewMode === "grid") {
    return (
      <>
        <GridView
          items={items}
          page={page}
          data={data}
          node={node}
          designerMode={designerMode}
          lightboxAvailable={lightboxAvailable}
          openLightbox={openLightbox}
          onLoadMore={onLoadMore}
          hasMore={hasMore}
          isLoadingMore={isLoadingMore}
          onLoadPrev={onLoadPrev}
          hasPrev={hasPrev}
          isLoadingPrev={isLoadingPrev}
          addSlide={props.addSlide}
        />
        {lightboxNode}
      </>
    );
  }

  if (viewMode === "gallery") {
    return (
      <div className="flex flex-col gap-3 w-full">
        {carouselNode}
        {showThumbs ? <ThumbStrip items={items} current={index} onSelect={handleChange} /> : null}
        {lightboxNode}
      </div>
    );
  }

  return (
    <>
      {carouselNode}
      {lightboxNode}
    </>
  );
};

export default BaseCarousel;

BaseCarousel.metaFields = carouselMetaFields;
