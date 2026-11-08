import { useMemo } from "react";
import fileManager from "@@file/file-manager";
import { __ } from "@global/i18n";

export default function ImageGrid({
  images,
  columns = 3,
  aspect = "aspect-[4/3]",
  rounded = "rounded-xl",
  gap = "gap-4",
  onImageClick,
  className = "",
}) {
  const slides = useMemo(() => {
    const mapped = fileManager.getMappedFiles(images) || [];
    return mapped
      .filter(f => f && (f.type === "image" || /^image\//.test(f.type || "")))
      .map(f => ({ src: f.src, thumb: f.previewSrc || f.src, name: f.name }));
  }, [images]);

  if (slides.length === 0) {
    return (
      <div className={`bg-secondary text-secondary-foreground ${rounded} ${aspect} flex items-center justify-center text-sm opacity-60 ${className}`}>
        {__("No images")}
      </div>
    );
  }

  const cols = Math.max(1, Math.min(4, parseInt(columns, 10) || 3));
  const gridCols = {
    1: "grid-cols-1",
    2: "grid-cols-1 sm:grid-cols-2",
    3: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3",
    4: "grid-cols-2 md:grid-cols-3 lg:grid-cols-4",
  }[cols];

  return (
    <div className={`grid ${gridCols} ${gap} ${className}`}>
      {slides.map((s, i) => (
        <button
          type="button"
          key={s.src + i}
          onClick={() => onImageClick?.(s, i)}
          className={`relative overflow-hidden ${rounded} ${aspect} bg-secondary group ${onImageClick ? "cursor-zoom-in" : "cursor-default"}`}
          aria-label={s.name || `Image ${i + 1}`}
        >
          <img
            src={s.src}
            alt={s.name || `Image ${i + 1}`}
            loading={i < 3 ? "eager" : "lazy"}
            draggable={false}
            className="absolute inset-0 w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
          />
        </button>
      ))}
    </div>
  );
}
