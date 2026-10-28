
import fileManager from "@@file/file-manager";
import {useDesigner} from "@context/designer-context";
import { getNodeKey } from "@global/prune-doc-structure";

export function ComponentDefaults(props) {
  const data = props.data || {};
  const {node} = props;
  const {updateElement, updateElements, designerMode, updatingFromEditor} = useDesigner();

  const getSrc = () => {
    if (data) {
      return fileManager.getMappedFiles(data.background_image || props.src, data.name);
    }
    return [];
  }

  const getTextSize = (size = data.size) =>{
    return {
      xm: "text-xs",
      sm: "text-sm",
      md: "text-md",
      lg: "text-lg",
      xl: "text-xl",
      "2xl": "text-2xl",
      "3xl": "text-3xl",
      "4xl": "text-4xl",
      "5xl": "text-5xl",
    }[size] || 5;
  }

  const getSize = (size = data.size) => {
    return {
      xs: "w-1/12",
      sm: "w-2/12",
      md: "w-3/12",
      lg: "w-4/12",
      xl: "w-5/12",
      "2xl": "w-6/12",
      "3xl": "w-7/12",
      "4xl": "w-8/12",
      "5xl": "w-9/12",
      "6xl": "w-10/12",
      "7xl": "w-11/12",
      full: "w-full",
    }[size] || "w-1/12";
  }

  const getTextAlign = (align = data.text_align) => {
    return {
      left: "text-left",
      center: "text-center",
      right: "text-right"
    }[(align || "left").toLowerCase()] || "text-left";
  }

  const set = (key, value) => {
    if (!designerMode) return;
    if (updatingFromEditor === node) return;

    const newData = {...data};
    if (typeof key == "object") {
      Object.keys(key).forEach((k) => {
        newData[k] = key[k];
      });
    } else {
      newData[key] = value;
    }

    setTimeout(() => {
      updateElement(node, JSON.parse(JSON.stringify(newData), true, false, true))
    }, 100);
  }

  const elementsDict = () => {
    return props.elements || [];
  }

  const setElements = (elements, callback, merge = true, options = {})=>{
    const newElements = (merge ? [...elementsDict(), ...elements] : elements);

    function removeDuplicates(array) {
      const seen = new Set();
      return array.filter(obj => {
        // getNodeKey resolves {node, key, data.key} across all formats —
        // critical for compatibility with auto-created cols and legacy nodes
        // not yet migrated to the canonical `node` property.
        const value = getNodeKey(obj);
        if (!seen.has(value)) {
          seen.add(value);
          return true;
        }
        return false;
      });
    }
    
    updateElements && updateElements(props, removeDuplicates(newElements), null, options);
  }

  return {
    getSrc,
    getTextSize,
    getTextAlign,
    set,
    setElements,
    getSize,
    data
  }
}

export const tagDontHaveChild = (tag) => {
  /**List Elements that don't have children */
  const singleTags = "input,textarea,img,switch,checkbox,hr,br,checkbox,script,link,base,area,basefont,frame,embed,source,track,wbr,image".split(",");

  return singleTags.includes(tag);
}

export const VARIANTS = {
  primary: "primary",
  secondary: "secondary",
  default: "default",
  ghost: "ghost",
  destructive: "destructive",
};

export const DEFAULTS = {
  layout: [50, 50],
  gap: 1,
  col_padding: "p-0",
  vertical_alignment: "top",
  row_height: "auto",
  stack_on: "md",
  reverse_on_mobile: false,
};

export const colPadding = ["p-0", "p-1", "p-2", "p-3", "p-4", "p-5", "p-6", "p-7", "p-8", "p-9"];


export const validTags = ["a", "abbr", "address", "area", "article", "aside", "audio", "b", "base", "bdi", "bdo", "blockquote", "body", "br", "button", "canvas", "caption", "cite", "code", "col", "colgroup", "data", "datalist", "dd", "del", "details", "dfn", "dialog", "div", "dl", "dt", "em", "embed", "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "head", "header", "hgroup", "hr", "html", "i", "iframe", "img", "input", "ins", "kbd", "label", "legend", "li", "link", "main", "map", "mark", "meta", "meter", "nav", "noscript", "object", "ol", "optgroup", "option", "output", "p", "param", "picture", "pre", "progress", "q", "rp", "rt", "ruby", "s", "samp", "script", "section", "select", "slot", "small", "source", "span", "strong", "style", "sub", "summary", "sup", "table", "tbody", "td", "template", "textarea", "tfoot", "th", "thead", "time", "title", "tr", "track", "u", "ul", "var", "video", "wbr"];