/**
 * Options vocabulary shared by `export const config`, entry defaults and
 * layout props.
 *
 * VIEW options — presentation, kept as React state (base/view-options.jsx):
 *   slots · actions · actionsInMenu · rowActions · handlers · columns · gridTemplate · sidebar · sidebarHeader ·
 *   primaryAction · canUpdate · readOnly · hasSidebar · hasHeader · hasBreadcrumb · hasHistory ·
 *   hasSearchForm · hasSelectAll · hasSelectRow · hiddenSearchFields · gridMinWidth · onlyList · onlyGrid
 *
 * CONTROLLER options — applied once to the controller instance:
 *   controller · notRequireChanges · restoreScroll · overrides (raw methods)
 */
export const VIEW_OPTION_KEYS = [
  "slots", "actions", "actionsInMenu", "rowActions", "handlers", "columns", "gridTemplate",
  "sidebar", "sidebarHeader", "primaryAction",
  "canUpdate", "readOnly", "hasSidebar", "hasHeader", "hasBreadcrumb", "hasHistory",
  "hasSearchForm", "hasSelectAll", "hasSelectRow", "hiddenSearchFields", "gridMinWidth",
  "onlyList", "onlyGrid",
];

/** Keyed options merge by key instead of replacing the whole map. */
const KEYED = new Set(["slots", "actions", "handlers"]);

const NO_SCROLL_RESTORE = {
  initScroll() { if (!this.props.inModal) window.scrollTo(0, 0); },
  setScrollPosition() {},
};

export function pickViewOptions(source = {}) {
  const out = {};
  for (const key of VIEW_OPTION_KEYS) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

/** Later layers win. */
export function mergeViewOptions(...layers) {
  const out = {};
  for (const layer of layers) {
    if (!layer) continue;
    for (const [key, value] of Object.entries(layer)) {
      if (value === undefined) continue;
      out[key] = KEYED.has(key) && out[key] && value ? { ...out[key], ...value } : value;
    }
  }
  return out;
}

export function pickControllerOverrides({ controller, notRequireChanges, restoreScroll, overrides } = {}) {
  return {
    ...(restoreScroll === false && NO_SCROLL_RESTORE),
    ...(controller !== undefined && { controller }),
    ...(notRequireChanges !== undefined && { notRequireChanges }),
    ...overrides,
  };
}
