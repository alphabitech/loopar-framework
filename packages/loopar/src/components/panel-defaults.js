import { createContext, useContext } from "react";

/**
 * Defaults a surface gives the panels inside it, below what each panel sets
 * itself. A desk form turns the hover/focus effects off: a panel that scales
 * on hover or rings on focus-within competes with the focus of its inputs.
 */
export const PanelDefaultsContext = createContext(null);

export const usePanelDefaults = () => useContext(PanelDefaultsContext);

/** What a desk form gives its panels. */
export const FORM_PANEL_DEFAULTS = Object.freeze({ hoverable: false, focusable: false });
