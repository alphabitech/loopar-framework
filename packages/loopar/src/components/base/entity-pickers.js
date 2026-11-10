/**
 * Element Editor pickers: entities and fields are chosen, not typed.
 * They read the Entity Directory (a virtual entity over the refs registry)
 * and store plain names, as the text inputs they replace did.
 */
const DIRECTORY = "Entity Directory";

/**
 * An entity, grouped by app. `mode`: records (default, entities that hold
 * records), child (child tables), all (entities and pages).
 */
export const entityPicker = (data = {}, mode = "records") => ({
  element: CONNECTION,
  data: {
    options: DIRECTORY,
    group_by: "app",
    ...(mode !== "records" ? { filters: `mode = ${mode}` } : {}),
    ...data,
  },
});

/**
 * A field of the entity chosen in the sibling prop `parent`. `kinds`:
 * discrete (default: select, radio group, single connection, switch,
 * checkbox), scalar (any one comparable value) or all.
 */
export const entityFieldPicker = (parent, data = {}, kinds = "discrete") => ({
  element: CONNECTION,
  data: {
    options: DIRECTORY,
    parent,
    filters: `mode = fields${kinds !== "discrete" ? `\nkinds = ${kinds}` : ""}`,
    ...data,
  },
});

/** Another field of the form being designed (see form-field.jsx). */
export const formFieldPicker = (data = {}, kinds = "discrete") => ({
  element: FORM_FIELD,
  data: { ...(kinds !== "discrete" ? { kinds } : {}), ...data },
});
