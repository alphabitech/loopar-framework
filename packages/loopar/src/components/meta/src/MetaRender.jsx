import React from "react";
import { useState, useRef, useEffect } from "react";
import { __META_COMPONENTS__ } from "@loopar/components-loader";
import { cn } from "@cn/lib/utils";
import loopar from "loopar";
import PureHTMLBlock from "@pure-html-block";
import { sanitizeAttributes } from "@global/custom-attributes";
const Animations = loopar.animation.animations();

const VISIBLE_ON = {
  mobile: "contents md:hidden",
  desktop: "hidden md:contents",
};

export const MetaRender = ({ meta, metaProps, Comp, docRef, parent, data, threshold = 0.1 }) => {
  const [isVisible, setIsVisible] = useState(false);
  const elementRef = useRef(null);
  
  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        setIsVisible(entry.isIntersecting);
      },
      { threshold: 0.1 }
    );

    if (elementRef.current) {
      observer.observe(elementRef.current);
    }

    return () => observer.disconnect();
  }, []);

  let className = metaProps.className;
  let style = metaProps.style || {};

  if (data.animation && Animations[data.animation]) {
    const animation = Animations[data.animation];

    className = cn(
      className,
      "transform transition-all ease-in-out",
      isVisible ? animation.visible : animation.initial,
      data.class
    );

    style = {
      ...style || {},
      transitionDelay: `${(data?.animation_delay || 0)}ms`,
      transitionDuration: `${(data?.animation_duration || 3000)}ms`,
    };
  }
  
  // Custom attributes (data-*, aria-*…) travel as top-level props; every
  // element forwards them to its root through rootProps().
  const attributes = sanitizeAttributes(data.attributes);

  if (meta.element === MARKDOWN) {
    return <PureHTMLBlock
      element={meta}
      {...loopar.utils.renderizableProps(metaProps)}
      {...attributes}
      data={data}
      className={className}
      style={style}
    />
  }

  if (!Comp) return null;

  // `contents` keeps the wrapper out of the layout (grids, flex rows); the
  // breakpoint class only toggles it between contents and none.
  const VisibilityWrapper = VISIBLE_ON[data.visible_on] ? "div" : React.Fragment;
  const visibilityProps = VISIBLE_ON[data.visible_on] ? { className: VISIBLE_ON[data.visible_on] } : {};

  return (
    <VisibilityWrapper {...visibilityProps}>
    <Comp
      {...metaProps}
      {...attributes}
      className={className}
      style={style}
      value={data.value}
      ref={ref => {
        if (ref) {
          elementRef.current = ref;
        }
        docRef?.fields?.registerRef(data.name, ref);
        if (parent && parent !== docRef) parent.fields?.registerRef(data.name, ref);
      }}
    />
    </VisibilityWrapper>
  );
}
