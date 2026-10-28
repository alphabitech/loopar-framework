import { useState, useRef, useEffect } from "react";
import { __META_COMPONENTS__ } from "@loopar/components-loader";
import { cn } from "@cn/lib/utils";
import loopar from "loopar";
import PureHTMLBlock from "@pure-html-block";
import {SEORender} from "@seo-render";
const Animations = loopar.animation.animations();

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
  
  if ([HTML_BLOCK, MARKDOWN].includes(meta.element)) {
    return <PureHTMLBlock
      element={meta}
      {...loopar.utils.renderizableProps(metaProps)}
      data={data}
      className={className}
      style={style}
    />
  }

  if (meta.element === SEO) {
    return <SEORender
      data={data}
    />
  }

  if (!Comp) return null;

  return (
    <Comp
      {...metaProps}
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
  );
}
