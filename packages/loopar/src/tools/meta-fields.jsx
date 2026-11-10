import loopar from "loopar";
import { elementsDict } from "@global/element-definition";

const normalizeOptions = (options) => {
  if (!options) return [];
  
  if (!Array.isArray(options) && typeof options === 'object') {
    return Object.entries(options).map(([key, label]) => ({
      value: key,
      label: typeof value == "string" ? value : key
    }));
  }
  
  return options.map(opt => {
    if (typeof opt === 'string') {
      return { value: opt, label: opt.charAt(0).toUpperCase() + opt.slice(1) };
    }
    if (opt.value !== undefined) return opt;
    if (opt.value !== undefined) {
      return { value: opt.value, label: opt.label || opt.value };
    }
    return opt;
  });
};

const createOptions = (...values) => {
  return values.map(v => {
    if (typeof v === 'string') {
      return { value: v, label: v.charAt(0).toUpperCase() + v.slice(1).replace(/-/g, ' ') };
    }
    if (Array.isArray(v)) {
      return { value: v[0], label: v[1] };
    }
    return v;
  });
};

const OPTIONS = {
  alignment: createOptions("left", "center", "right"),
  vertical_alignment: createOptions("top", "center", "bottom"),
  size: createOptions(
    ["xs", "Extra Small"],
    ["sm", "Small"],
    ["md", "Medium"],
    ["lg", "Large"],
    ["xl", "Extra Large"]
  ),
  background_size: createOptions("cover", "contain", "auto"),
  blend_mode: createOptions(
    "normal", "multiply", "screen", "overlay",
    "darken", "lighten", "color-dodge", "color-burn",
    "hard-light", "soft-light", "difference", "exclusion",
    "hue", "saturation", "color", "luminosity"
  ),
};

const DEFAULTS = {
  background_size: "cover",
  background_blend_mode: "overlay",
  animation_duration: 1000,
  animation_delay: 0,
};

/**
 * Fields of the "content" section, from the element's content schema
 * (element-definition.js `content`): one field per visible text, typed
 * line → input, text/lines → textarea. Rich values (markdown) are edited by
 * the element itself. Writable (form) elements have their own fields.
 */
const CONTENT_FIELD = {
  line: () => ({ element: INPUT }),
  text: () => ({ element: TEXTAREA, data: { rows: 3 } }),
  lines: () => ({ element: TEXTAREA, data: { rows: 6, description: "One item per line." } }),
};

const contentFields = (element) => {
  const def = elementsDict[element.element]?.def;
  if (!def || def.isWritable) return {};
  return Object.entries(def.content || {}).reduce((acc, [prop, type]) => {
    const make = CONTENT_FIELD[type];
    if (!make) return acc;
    const field = make();
    acc[prop] = { ...field, data: { label: loopar.utils.Capitalize(prop.replaceAll("_", " ")), ...(field.data || {}) } };
    return acc;
  }, {});
};

export const getMetaFields = (element) => {
  return [
    {
      group: "content",
      elements: contentFields(element),
    },
    {
      group: "style",
      elements: {
        class: {
          element: TAILWIND,
          data: {
            label: "Tailwind",
            rows: 6,
            to_element: element.node,
          },
        },
        background_image: {
          element: IMAGE_INPUT,
          data: { label: "Background", height: 150 },
        },
        background_color: {
          element: COLOR_PICKER,
          data: { label: "Color" },
        },
        background_blend_mode: {
          element: SELECT,
          data: {
            label: "Blend Mode",
            options: OPTIONS.blend_mode,
            selected: DEFAULTS.background_blend_mode,
          },
        },
        background_size: {
          element: SELECT,
          data: {
            label: "Background Size",
            options: OPTIONS.background_size,
            selected: DEFAULTS.background_size,
          },
        },
        inline_css: {
          element: TEXTAREA,
          data: {
            label: "Inline CSS",
            description: "Raw CSS text (e.g. 'color: red; font-size: 20px;'). Parsed and applied as inline style on the rendered element. For programmatic JSON authoring you can alternatively set `inline_style` to a plain object.",
            rows: 3,
          },
        },
        hidden: {
          element: SWITCH,
          data: { label: "Hidden" },
        },
        visible_on: {
          element: SELECT,
          data: {
            label: "Visible On",
            description: "Show this element only on some screen sizes (breakpoint: md).",
            options: [
              { value: "", label: "All screens" },
              { value: "mobile", label: "Mobile only" },
              { value: "desktop", label: "Desktop only" },
            ],
          },
        },
        disabled: {
          element: SWITCH,
          data: { label: "Disabled" },
        },
        text_align: {
          element: SELECT,
          data: {
            options: OPTIONS.alignment
          }
        }
      },
    },
    {
      group: "animation",
      elements: {
        animation: {
          element: SELECT,
          data: {
            label: "Effect",
            options: [
              { value: "", label: "None" },
              ...normalizeOptions(loopar.animation.animations()),
            ],
            selected: "", 
          },
        },
        animation_duration: {
          element: INPUT,
          data: {
            label: "Duration (ms)",
            format: "number",
            default_value: DEFAULTS.animation_duration,
          },
        },
        animation_delay: {
          element: INPUT,
          data: {
            label: "Delay (ms)",
            format: "number",
            default_value: DEFAULTS.animation_delay,
          },
        },
      },
    },
    {
      group: "advanced",
      elements: {
        name: {
          element: INPUT,
          data: { label: "Name", description: "Internal name (form fields, anchors, scripts)." },
        },
        id: {
          element: INPUT,
          data: {
            label: "ID",
            description: "Unique identifier",
          },
        },
        display_on: {
          element: TEXTAREA,
          data: {
            label: "Display Condition",
            rows: 2,
          },
        },
        attributes: {
          element: METADATA,
          data: {
            label: "Attributes",
            description: "Custom HTML attributes for the element's root: data-*, aria-*, role, itemprop, itemscope, itemtype, rel, title, lang… Event handlers, style, class and id are ignored.",
            key_label: "Attribute",
            value_label: "Value",
          },
        },
      },
    },
  ];
};

export { OPTIONS, DEFAULTS, createOptions, normalizeOptions };