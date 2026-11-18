import { elementsDict } from "./element-definition.js";

const FIELD_DEFAULTS = Object.freeze({
  format: "data",
  size: "md",
  type: "default",
});

const FRAMEWORK_OWNED_FIELDS = new Set([
  "id","__created_at__", "__updated_at__", "__deleted_at__", "__document_status__",
  "__created_by__", "__version__",
]);

const EMPTY_BG_VARIANTS = new Set([
  '{"color":"","alpha":0}',
  '{"color":"","alpha":0.5}',
  '{"color":"#000000","alpha":0.5}',
  '{"color":"#000000","alpha":0}',
]);

const KEEP_NUMERIC_ZERO = new Set([
  "default_value",
  "default",
  "min",
  "max",
  "step",
  "length",
  "decimals",
  "precision",
  "rows",
  "cols",
  "max_length",
  "min_length",
]);

const NEVER_PERSIST = new Set([
  "rendered_value",
  "reviews",
  "value_descriptive",
  "previewSrc",
  "mappedFiles",
  "tag",
  "style",
  "imageProps",
  "coverProps",
  "className",
  "parent",
  "parentKey",
]);

const isPlainObject = (v) =>
  v !== null && typeof v === "object" && !Array.isArray(v);

const isEmptyValue = (v) => {
  if (v === null || v === undefined) return true;
  if (v === "" || v === "null" || v === "undefined") return true;
  if (Array.isArray(v) && v.length === 0) return true;
  if (isPlainObject(v) && Object.keys(v).length === 0) return true;
  return false;
};

const isPrunableZero = (v) => v === 0 || v === "0";

const isEmptyBackground = (k, v) => {
  if (k !== "background_color" && k !== "color_overlay") return false;
  if (!isPlainObject(v)) return false;
  const norm = JSON.stringify({ color: v.color ?? "", alpha: v.alpha ?? 0 });
  return EMPTY_BG_VARIANTS.has(norm);
};

const pruneDeep = (v) => {
  if (Array.isArray(v)) {
    return v.map(pruneDeep).filter((x) => !isEmptyValue(x));
  }
  if (isPlainObject(v)) {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      const cleaned = pruneDeep(val);
      if (isEmptyValue(cleaned)) continue;
      out[k] = cleaned;
    }
    return out;
  }
  return v;
};

const pruneData = (data, nodeKey, isWritable = false) => {
  if (!isPlainObject(data)) return data;
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    if (NEVER_PERSIST.has(k)) continue;
    if (k === "key") continue;
    if (k === "id" && v === nodeKey) continue;
    if (k === "name" && v === nodeKey && !isWritable) continue;

    if (isEmptyValue(v)) continue;
    if (FIELD_DEFAULTS[k] !== undefined && v === FIELD_DEFAULTS[k]) continue;
    if (isPrunableZero(v) && !KEEP_NUMERIC_ZERO.has(k)) continue;
    if (isEmptyBackground(k, v)) continue;

    if (isPlainObject(v) || Array.isArray(v)) {
      const cleaned = pruneDeep(v);
      if (isEmptyValue(cleaned)) continue;
      out[k] = cleaned;
      continue;
    }

    out[k] = v;
  }
  return out;
};

const pruneNode = (node) => {
  if (!isPlainObject(node)) return node;
  const out = {};

  const lifted = node.node ?? node.key ?? node.data?.key ?? null;
  if (lifted) out.node = lifted;

  if (node.element !== undefined) out.element = node.element;

  const isWritable = fieldIsWritable(node);

  let dataIn = node.data || {};
  if (isWritable && !dataIn.name && lifted) {
    dataIn = { ...dataIn, name: lifted };
  }

  if (isWritable && dataIn.name && FRAMEWORK_OWNED_FIELDS.has(dataIn.name)) {
    return null;
  }

  out.data = pruneData(dataIn, lifted, isWritable);

  if (Array.isArray(node.elements) && node.elements.length > 0) {
    const pruned = node.elements.map(pruneNode).filter(n => n !== null);
    if (pruned.length > 0) out.elements = pruned;
  }

  for (const [k, v] of Object.entries(node)) {
    if (k === "element" || k === "elements" || k === "data") continue;
    if (k === "node" || k === "key") continue;
    if (NEVER_PERSIST.has(k)) continue;

    if (isPlainObject(v) || Array.isArray(v)) {
      const cleaned = pruneDeep(v);
      if (isEmptyValue(cleaned)) continue;
      out[k] = cleaned;
      continue;
    }
    if (isEmptyValue(v)) continue;
    out[k] = v;
  }

  return out;
};

export const pruneDocStructure = (tree) => {
  if (Array.isArray(tree)) return tree.map(pruneNode).filter(n => n !== null);
  if (isPlainObject(tree))  return pruneNode(tree);
  return tree;
};

export const pruneDocStructureValue = (value) => {
  if (value == null || value === "") return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return JSON.stringify(pruneDocStructure(parsed));
    } catch {
      return value;
    }
  }
  return pruneDocStructure(value);
};

export const getNodeKey = (node) =>
  node?.node ?? node?.key ?? node?.data?.key ?? getUniqueKey();

export function getUniqueKey() {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

const liftKeyOnNode = (node) => {
  if (!isPlainObject(node)) return node;
  const out = { ...node };

  const id = out.node ?? out.key ?? out.data?.key ?? null;
  if (id != null) out.node = id;
  if ("key" in out) delete out.key;
  if (out.data && "key" in out.data) {
    out.data = { ...out.data };
    delete out.data.key;
  }

  if (Array.isArray(out.elements) && out.elements.length > 0) {
    out.elements = out.elements.map(liftKeyOnNode);
  }

  return out;
};

export const liftKeyToNode = (tree) => {
  if (Array.isArray(tree)) return tree.map(liftKeyOnNode);
  if (isPlainObject(tree)) return liftKeyOnNode(tree);
  return tree;
};

export default pruneDocStructure;
