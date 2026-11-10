import {PreassembledContextProvider, usePreassembledContext} from "@preassembled";
import { cn } from "@cn/lib/utils";
import {Droppable} from "@droppable";
import {loopar} from "loopar";
import {useState, useRef, useEffect} from "react";
import { useDesigner } from "@context/designer-context";

const Cover = (props) => {
  const {designing} = useDesigner()
  const [isVisible, setIsVisible] = useState(designing || false);
  const elementRef = useRef(null);
  const animation = loopar.animation.getAnimation(props.animation) || {}

  useEffect(() => {
    if(designing) return;
    const observer = new IntersectionObserver(([entry]) => {
      setIsVisible(entry.isIntersecting);
    }, { threshold: 0.1 });

    if (elementRef.current) {
      observer.observe(elementRef.current);
    }

    return () => observer.disconnect();
  }, [designing]);

  return (
    <div 
      {...props}
      className={cn(props.className, (isVisible ? animation.visible : animation.initial))}
      ref={elementRef}
    />
  )
}

const Content = (props) => {
  const { isActive = true, contentAnimation = "reveal", isPrevSlide, animation } = props;
  const {designing} = useDesigner();
  const crossfade = contentAnimation === "fade" || contentAnimation === "inherit";
  const [isVisible, setIsVisible] = useState(
    designing || contentAnimation === "static" || (crossfade && isPrevSlide) || false
  );

  useEffect(() => {
    if(designing || contentAnimation === "static") return;
    let timeout;

    if (crossfade) {
      timeout = setTimeout(() => setIsVisible(!isPrevSlide), 30);
    } else if (isActive) {
      timeout = setTimeout(() => {
        setIsVisible(true);
      }, 1000);
    } else {
      setIsVisible(false);
    }

    return () => clearTimeout(timeout);
  }, [isActive, designing, contentAnimation, crossfade, isPrevSlide]);

  const inheritAnim =
    contentAnimation === "inherit" ? (loopar.animation.getAnimation(animation) || {}) : null;
  const hasInherit = !!(inheritAnim && (inheritAnim.visible || inheritAnim.initial));

  let animationClassName = "";
  if (hasInherit) {
    animationClassName = cn(
      "transition-all ease-in-out",
      isPrevSlide ? "duration-700" : "duration-500",
      props.haveCarousel && (isVisible ? inheritAnim.visible : inheritAnim.initial)
    );
  } else if (crossfade) {
    animationClassName = cn(
      "transition-opacity ease-out",
      isPrevSlide ? "duration-700" : "duration-300",
      props.haveCarousel && (isVisible ? "opacity-100" : "opacity-0")
    );
  } else if (contentAnimation !== "static") {
    animationClassName = cn(
      "transition-all duration-700 ease-out",
      props.haveCarousel && (isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4")
    );
  }
  const skipAnimation = designing || contentAnimation === "static";
  
  if (props.textBackground) {
    return (
      <div
        className={cn(
          props.wrapperClassName,
          skipAnimation ? '' : animationClassName
        )}
      >
        <div className={cn("flex h-full w-full p-4 md:p-8", props.className)}>
          <Droppable
            {...props}
            className={cn(
              "flex flex-col gap-4 w-full max-w-3xl bg-card/50 rounded-2xl p-6 md:p-10 shadow-lg",
              props.textBackgroundClass
            )}
          />
        </div>
      </div>
    )
  }

  return (
    <div
      className={cn(
        props.wrapperClassName,
        skipAnimation ? '' : animationClassName
      )}
    >
      <Droppable
        {...props}
        className={cn("h-full w-full flex flex-col gap-4", props.className,)}
      />
    </div>
  )
}

function Banner() {
  const {props} = usePreassembledContext()
  const data = props.data || {};
  const {designerMode} = useDesigner();

  const alignment = {
    center: "justify-center items-center",
    start: "justify-start items-start",
    end: "justify-end items-end",
  }[data?.align || "center"];
  
  const coverClassName = cn(
    "h-full w-full",
    "transform transition-all ease-in-out",
    "absolute inset-0 z-0",
  );

  const isActive = data.isActive !== false;
  const animationDuration = (parseFloat(data.animation_duration) || 0.7);
  const textBackground = loopar.utils.trueValue(data.text_background);
  const contentAnimation =
    data.content_animation || (loopar.utils.trueValue(data.static_content) ? "fade" : "reveal");
  const isPrevSlide = loopar.utils.trueValue(data.is_prev_slide);

  const joinedAnim =
    contentAnimation === "inherit" && props.haveCarousel
      ? (loopar.animation.getAnimation(data.animation) || {})
      : null;
  const hasJoined =
    !!(joinedAnim && (joinedAnim.visible || joinedAnim.initial)) && !designerMode;
  const [joinedVisible, setJoinedVisible] = useState(isPrevSlide);
  useEffect(() => {
    if (!hasJoined) return;
    const t = setTimeout(() => setJoinedVisible(!isPrevSlide), 30);
    return () => clearTimeout(t);
  }, [hasJoined, isPrevSlide]);

  
  return (
    <div className={cn(
      props.className.split("transition-all")[0],
      "p-0 relative",
      data.full_height && !designerMode && "h-[calc(100vh-var(--spacing-web-header-height))] max-h-[calc(100vh-var(--spacing-web-header-height))]",
      hasJoined && cn(
        "transition-all ease-in-out",
        isPrevSlide ? "duration-700" : "duration-500",
        joinedVisible ? joinedAnim.visible : joinedAnim.initial
      ),
    )}>
      <Cover
        className={coverClassName}
        style={props.style}
        animation={hasJoined ? undefined : data.animation}
      />
      <Content  
        elements={props.elements}
        // "relative" is required for z-10 to apply: a static element's
        // background paints BELOW positioned elements (the absolute Cover),
        // so without it the panel's bg-card only showed when backdrop-blur
        // forced a stacking context.
        wrapperClassName="relative inset-0 z-10 h-full w-full"
        className={cn(alignment, data.class)}
        isActive={isActive}
        animationDuration={animationDuration}
        haveCarousel={props.haveCarousel}
        textBackground={textBackground}
        textBackgroundClass={data.text_background_class}
        contentAnimation={hasJoined ? "static" : contentAnimation}
        isPrevSlide={isPrevSlide}
        animation={data.animation}
      />
    </div>
  )
}

export default function MetaBanner(props){
  const data = props.data;
  const defaultElements = [
    {
      element: "heading",
      node: props.node + "title",
      data: {
        text: data?.label || "Banner Title...",
        level: "h2",
        size: "display",
        text_align: "center",
      },
    },
    {
      element: "heading",
      node: props.node + "subtitle",
      data: {
        level: "h3",
        size: "xl",
        text: data?.text || "Subtitle...",
        text_align: "center",
      },
    },
  ];

  return (
    <PreassembledContextProvider {...props} defaultElements={defaultElements}>
      <Banner/>
    </PreassembledContextProvider>
  )
}


MetaBanner.metaFields =()=>{
  return [{
    group: "custom",
    elements: {
      align: {
        element: SELECT,
        data: {
          options: ["center", "start", "end"],
        }
      },
      full_height: {
        element: SWITCH,
        data: {
          description:
            "If enabled the slider will have the height of the screen.",
        },
      },
      text_background: {
        element: SWITCH,
        data: {
          label: "Text Background",
          description:
            "Render this banner's content inside a translucent themed panel so text stays readable over the background image. Overridden to ON when the parent carousel enables Text Background.",
        },
      },
      text_background_class: {
        element: INPUT,
        data: {
          label: "Text Background Class",
          description:
            "Optional Tailwind classes merged over the panel defaults (bg-card/50 backdrop-blur-sm rounded-2xl ...). E.g. 'bg-black/30' or 'bg-card/80 backdrop-blur-md'.",
        },
      },
    }
  }];
}