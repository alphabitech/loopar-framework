import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@cn/components/ui/dialog";
import CarouselBase from "./carousel.jsx";
import { __ } from "@global/i18n";

export default function CarouselLightbox({
  open,
  index,
  onChange,
  onClose,
  slides = [],
  renderSlide,
  renderArrowLeft,
  renderArrowRight,
  renderIndicators,
  loop = true,
  exitDurationMs = 0,
  transitionDurationMs = 500,
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose?.(); }}>
      <DialogContent className="max-w-[96vw] md:max-w-[92vw] w-full h-[92vh] p-0 gap-0 bg-black/95 border-0 sm:rounded-xl overflow-hidden">
        <DialogTitle className="sr-only">{__("Image viewer")}</DialogTitle>
        {open && index != null ? (
          <div className="absolute inset-0">
            <CarouselBase
              slides={slides}
              renderSlide={renderSlide}
              renderArrowLeft={renderArrowLeft}
              renderArrowRight={renderArrowRight}
              renderIndicators={renderIndicators}
              current={index}
              onChange={onChange}
              autoplay={false}
              loop={loop}
              keyboard
              touch
              exitDurationMs={exitDurationMs}
              transitionDurationMs={transitionDurationMs}
              containerClassName="absolute inset-0 w-full h-full grid grid-cols-1 [grid-template-rows:1fr] items-center overflow-hidden select-none group"
            />
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
