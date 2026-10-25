import elementManage from "@@tools/element-manage";

import fileManager from "@global/file-manager.js";
import {loopar} from "loopar";
import {useMemo} from "react";

import { useDesigner } from "@context/designer-context";

export function designElementProps(el) {
  if (!el.data) {
    const names = elementManage.elementName(el.element);
    el.node ??= names.key;
    el.data = {
      label: names.label,
    }
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
        out.imageProps.alt = data.label || "";
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

/*
 * `display_on` conditions: `field op value` joined by and/or (&&, ||), with
 * parentheses and `not`/`!`. Operators: = == != > < >= <=. Values: 'quoted',
 * "quoted", numbers or bare words (literals). A lone field tests truthiness.
 * Parsed here, never eval'd: the old regex rewrite turned `worker` into
 * `w||ker`, `>=` into `>==` and broke on quotes inside values.
 */
const TOKEN = /\s*(?:(\(|\)|!=|==|>=|<=|=|>|<|&&|\|\||!)|'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|(-?\d+(?:\.\d+)?)(?![\w.])|([A-Za-z_][\w.]*))/y;

function tokenize(condition) {
  const tokens = [];
  const src = String(condition ?? "");
  TOKEN.lastIndex = 0;
  let pos = 0;
  while (pos < src.length) {
    if (!src.slice(pos).trim()) break;
    TOKEN.lastIndex = pos;
    const m = TOKEN.exec(src);
    if (!m) throw new Error(`Unexpected "${src.slice(pos, pos + 10)}"`);
    pos = TOKEN.lastIndex;
    if (m[1]) tokens.push({ type: "op", value: m[1] });
    else if (m[2] !== undefined || m[3] !== undefined) tokens.push({ type: "str", value: (m[2] ?? m[3]).replace(/\\(.)/g, "$1") });
    else if (m[4] !== undefined) tokens.push({ type: "num", value: m[4] });
    else {
      const word = m[5];
      const lower = word.toLowerCase();
      if (lower === "and") tokens.push({ type: "op", value: "&&" });
      else if (lower === "or") tokens.push({ type: "op", value: "||" });
      else if (lower === "not") tokens.push({ type: "op", value: "!" });
      else tokens.push({ type: "id", value: word });
    }
  }
  return tokens;
}

const FALSY = new Set([undefined, null, "", 0, "0", false, "false"]);
const COMPARE = new Set(["=", "==", "!=", ">", "<", ">=", "<="]);

function compare(left, op, right) {
  const ln = Number(left), rn = Number(right);
  const numeric = left !== "" && left != null && right !== "" && !isNaN(ln) && !isNaN(rn);
  const l = String(left ?? ""), r = String(right ?? "");
  switch (op) {
    case "=": case "==": return numeric ? ln === rn : l === r;
    case "!=": return numeric ? ln !== rn : l !== r;
    case ">": return numeric ? ln > rn : l > r;
    case "<": return numeric ? ln < rn : l < r;
    case ">=": return numeric ? ln >= rn : l >= r;
    case "<=": return numeric ? ln <= rn : l <= r;
  }
  return false;
}

export function evaluateCondition(condition, values = {}) {
  try {
    const tokens = tokenize(condition);
    let i = 0;
    const peek = () => tokens[i];
    const take = () => tokens[i++];

    const primary = () => {
      const t = take();
      if (!t) throw new Error("Unexpected end");
      if (t.type === "op" && t.value === "!") return !primary();
      if (t.type === "op" && t.value === "(") {
        const v = orExpr();
        if (take()?.value !== ")") throw new Error("Missing )");
        return v;
      }
      if (t.type !== "id") throw new Error(`Unexpected ${t.value}`);
      const left = values[t.value];
      const next = peek();
      if (next?.type === "op" && COMPARE.has(next.value)) {
        take();
        const r = take();
        if (!r || r.type === "op") throw new Error("Missing value");
        return compare(left, next.value, r.value);
      }
      return !FALSY.has(left);
    };
    const andExpr = () => {
      let v = primary();
      while (peek()?.value === "&&") { take(); const r = primary(); v = v && r; }
      return v;
    };
    const orExpr = () => {
      let v = andExpr();
      while (peek()?.value === "||") { take(); const r = andExpr(); v = v || r; }
      return v;
    };

    const result = orExpr();
    if (i < tokens.length) throw new Error(`Unexpected ${tokens[i].value}`);
    return !!result;
  } catch (error) {
    console.error(`Error evaluating condition "${condition}":`, error.message);
    return false;
  }
}

/** Fields a condition reads (left side of comparisons and lone fields). */
export function extractFieldNames(condition) {
  let tokens;
  try { tokens = tokenize(condition); } catch { return []; }
  const fields = new Set();
  tokens.forEach((t, i) => {
    const prev = tokens[i - 1];
    if (t.type === "id" && !(prev?.type === "op" && COMPARE.has(prev.value))) fields.add(t.value);
  });
  return [...fields];
}
