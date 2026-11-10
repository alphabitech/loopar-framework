import elementManage from "@@tools/element-manage";
import { elementsDict } from "@global/element-definition";

import fileManager from "@global/file-manager.js";
import {loopar} from "loopar";
import {useMemo} from "react";

import { useDesigner } from "@context/designer-context";

export function designElementProps(el) {
  if (!el.data) {
    const names = elementManage.elementName(el.element);
    el.node ??= names.key;
    el.data = elementsDict[el.element]?.def?.isWritable ? { label: names.label } : {};
  }

  return el;
};

const hasOwnKeys = (o) => o && typeof o === "object" && Object.keys(o).length > 0;
const mergeStyle = (target, addition) => {
  if (!hasOwnKeys(addition)) return target;
  const base = hasOwnKeys(target) ? target : {};
  return { ...base, ...addition };
};

const parseCssText = (css) => {
  if (typeof css !== "string" || !css.trim()) return null;
  const out = {};
  for (const decl of css.split(";")) {
    const [rawProp, ...rest] = decl.split(":");
    if (!rawProp || rest.length === 0) continue;
    const prop = rawProp.trim();
    const value = rest.join(":").trim();
    if (!prop || !value) continue;

    const reactKey = prop.startsWith("--")
      ? prop
      : prop.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    out[reactKey] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
};

export const toCssText = (obj) => {
  if (!obj || typeof obj !== "object") return "";
  const parts = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null || value === "") continue;
    const cssKey = key.startsWith("--")
      ? key
      : key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
    parts.push(`${cssKey}: ${value};`);
  }
  return parts.join(" ");
};

export function prepareMeta(metaProps) {
  const out = { ...metaProps };
  out.data = out.data ? { ...out.data } : {};
  out.elements = out.elements || [];

  const data = out.data;

  const getSrc = () => fileManager.getMappedFiles(data.background_image, data.name) || [];

  const backgroundColor = {};
  if (data.background_color) {
    const color = loopar.utils.objToRGBA(data.background_color);
    if (color) {
      backgroundColor.backgroundColor = color;
      backgroundColor.backgroundBlendMode = data.background_blend_mode || 'normal';
    }
  }

  if (data.background_image && data.background_image.length > 0) {
    const src = getSrc();
    if (src.length > 0) {
      const imageUrl = src[0].src || "/uploads/empty-image.svg";
      const backgroundImage = {
        backgroundImage: `url("${imageUrl}")`,
        backgroundSize: data.background_size || "cover",
        backgroundPosition: data.background_position || "center",
        backgroundRepeat: data.background_repeat || "no-repeat",
        ...backgroundColor,
      };

      out.imageProps = { src: imageUrl };

      if (out.element === "image") {
        out.imageProps.alt = data.alt || data.label || "";
        out.imageProps.title = data.description || "";
        out.coverProps = { style: { ...backgroundImage } };
      } else {
        const merged = mergeStyle(out.style, backgroundImage);
        if (hasOwnKeys(merged)) out.style = merged;
      }
    }
  }

  if (out.element !== "image") {
    const merged = mergeStyle(out.style, backgroundColor);
    if (hasOwnKeys(merged)) out.style = merged;
  }

  const parsedCss = parseCssText(data.inline_css);
  if (parsedCss) {
    out.style = mergeStyle(out.style, parsedCss);
  }

  return out;
}

export const useBuildMetaProps = (props) => {
  const { designerMode } = useDesigner();

  return useMemo(() => {
    const mp = prepareMeta(props.meta);
    if (designerMode) {
      return designElementProps(mp);
    }
 
    return mp;
  }, [designerMode, props.meta]);
};

export { evaluateCondition, extractFieldNames } from "@global/condition";
