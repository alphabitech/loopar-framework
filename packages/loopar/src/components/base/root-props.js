import { isAllowedAttribute } from "@global/custom-attributes";

/**
 * The root contract every page element follows: the element's root DOM node
 * receives the layout classes, inline style, ref, anchor id and the custom
 * attributes resolved by MetaRender (already sanitized, passed as top-level
 * `data-*` / `aria-*` / allowed props).
 */
export function rootProps(props = {}) {
  const out = {
    className: props.className,
    style: props.style,
  };
  if (props.ref) out.ref = props.ref;
  if (props.data?.id) out.id = props.data.id;

  for (const [key, value] of Object.entries(props)) {
    if (typeof value === "object" || typeof value === "function") continue;
    if (key === "className" || key === "id") continue;
    if (isAllowedAttribute(key)) out[key] = value;
  }
  return out;
}
