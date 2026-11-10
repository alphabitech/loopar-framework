import { createContext, useContext } from "react";

/**
 * What the Element Editor's own fields may know about the form being
 * designed: its structure (`metaTree`) and the element being edited. Inside
 * the editor the DesignerContext is blanked on purpose, so pickers read it
 * from here.
 */
export const ElementEditorContext = createContext(null);

export const useElementEditor = () => useContext(ElementEditorContext);
