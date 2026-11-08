import { useMemo, useState } from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import fileManager from "@@file/file-manager";
import CarouselBase from "../carousel/carousel.jsx";
import { __ } from "@global/i18n";

export default function ImageCarousel({
  images,
  aspect = "aspect-[16/10]",
  rounded = "rounded-xl",
  showThumbs = true,
  showCounter = true,
  showDots = true,
  showArrows = true,
  onImageClick,
  className = "",
  autoplay = false,
  intervalMs = 5000,
  loop = true,
  keyboard = false,
  touch = true,
  pauseOnHover = true,
  defaultIndex = 0,
  current,
  onChange,
}) {
  const slides = useMemo(() => {
    const mapped = fileManager.getMappedFiles(images) || [];
    return mapped
      .filter(f => f && (f.type === "image" || /^image\//.test(f.type || "")))
      .map(f => ({ src: f.src, thumb: f.previewSrc || f.src, name: f.name }));
  }, [images]);

  const [localIndex, setLocalIndex] = useState(defaultIndex);
  const isExternallyControlled = typeof current === "number";
  const activeIndex = isExternallyControlled ? current : localIndex;

  const handleChange = (nextIndex, prevIndex) => {
    if (!isExternallyControlled) setLocalIndex(nextIndex);
    onChange?.(nextIndex, prevIndex);
  };

  if (slides.length === 0) {
    return (
      <div className={`bg-secondary text-secondary-foreground ${rounded} ${aspect} flex items-center justify-center text-sm opacity-60 ${className}`}>
        {__("No images")}
      </div>
    );
  }

  const renderSlide = (slide, ctx) => (
    <img
      key={slide.src + ctx.index}
      src={slide.src}
      alt={slide.name || `Image ${ctx.index + 1}`}
      loading={ctx.index === 0 ? "eager" : "lazy"}
      draggable={false}
      onClick={() => onImageClick?.(slide, ctx.index)}
      className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-500 ${
        ctx.isCurrent ? "opacity-100" : "opacity-0 pointer-events-none"
      } ${onImageClick ? "cursor-zoom-in" : ""}`}
    />
  );

  const arrowBtnCls = "absolute top-1/2 -translate-y-1/2 w-9 h-9 rounded-full bg-background/70 text-foreground backdrop-blur flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity";

  const renderArrowLeft = ({ onClick }) =>
    showArrows && slides.length > 1 ? (
      <button type="button" aria-label={__("Previous image")} onClick={onClick} className={`${arrowBtnCls} left-2`}>
        <ChevronLeftIcon className="w-5 h-5" />
      </button>
    ) : null;

  const renderArrowRight = ({ onClick }) =>
    showArrows && slides.length > 1 ? (
      <button type="button" aria-label={__("Next image")} onClick={onClick} className={`${arrowBtnCls} right-2`}>
        <ChevronRightIcon className="w-5 h-5" />
      </button>
    ) : null;

  const renderIndicators = ({ current, count, goTo }) =>
    showDots && count > 1 ? (
      <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex gap-1.5">
        {slides.map((_, i) => (
          <button
            type="button"
            key={i}
            aria-label={`Go to image ${i + 1}`}
            onClick={() => goTo(i)}
            className={`w-2 h-2 rounded-full transition-all ${
              i === current ? "bg-primary w-5" : "bg-background/70 hover:bg-background"
            }`}
          />
        ))}
      </div>
    ) : null;

  const renderBefore = ({ index, count }) =>
    showCounter && count > 1 ? (
      <div className="absolute top-2 right-2 text-xs px-2 py-1 rounded-md bg-background/70 text-foreground backdrop-blur">
        {index + 1} / {count}
      </div>
    ) : null;

  return (
    <div className={`flex flex-col gap-3 ${className}`}>
      <CarouselBase
        slides={slides}
        renderSlide={renderSlide}
        renderArrowLeft={renderArrowLeft}
        renderArrowRight={renderArrowRight}
        renderIndicators={renderIndicators}
        renderBefore={renderBefore}
        autoplay={autoplay}
        intervalMs={intervalMs}
        loop={loop}
        keyboard={keyboard}
        touch={touch}
        pauseOnHover={pauseOnHover}
        current={activeIndex}
        onChange={handleChange}
        containerClassName={`relative bg-card ${rounded} overflow-hidden ${aspect} group select-none`}
      />

      {showThumbs && slides.length > 1 ? (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {slides.map((s, i) => (
            <button
              type="button"
              key={s.src + i}
              onClick={() => handleChange(i, activeIndex)}
              className={`relative shrink-0 w-20 h-14 rounded-md overflow-hidden border-2 transition-all ${
                i === activeIndex ? "border-primary" : "border-transparent opacity-70 hover:opacity-100"
              }`}
              aria-label={`Show image ${i + 1}`}
            >
              <img
                src={s.thumb || s.src}
                alt={s.name || `Thumbnail ${i + 1}`}
                loading="lazy"
                className="w-full h-full object-cover"
              />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
