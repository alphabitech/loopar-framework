import { useContext, createContext, useMemo } from "react";
import { usePersist } from "@services/persist-state";
import { ViewOptionsProvider } from "./view-options";

/**
 * Base layer of every entry: publishes the controller, the Document and the
 * entry's layout. `useDocument()` → { ctrl, Document, inModal, onClose, onSaved, ... }.
 */
export const DocumentContext = createContext({});

export const DocumentProvider = ({ ctrl, layout, options, children }) => {
  const Document = ctrl.Document;
  const [sidebarOpen, setSidebarOpen] = usePersist(Document.name + "sidebarOpen");
  const { inModal, onClose, onSaved } = ctrl.props || {};

  const value = useMemo(() => ({
    ctrl,
    /** @deprecated use `ctrl` */
    docRef: ctrl,
    Document,
    name: Document.name,
    entity: Document.Entity?.name,
    entityMenu: Document.__DOCUMENT_TITLE__,
    spacing: Document.spacing,
    layout,
    inModal,
    onClose,
    onSaved,
    sidebarOpen,
    handleSetSidebarOpen: setSidebarOpen,
  }), [ctrl, Document, layout, inModal, onClose, onSaved, sidebarOpen, setSidebarOpen]);

  return (
    <DocumentContext.Provider value={value}>
      <ViewOptionsProvider base={options}>
        <title>{Document.meta?.title}</title>
        {children}
      </ViewOptionsProvider>
    </DocumentContext.Provider>
  );
};

export const useDocument = () => useContext(DocumentContext);

/**
 * The layout of the current entry (FormLayout for a form, ListLayout for a
 * list...). Views that know their kind import that layout directly; this one
 * serves `DefaultView` and views that must work under any entry.
 */
export function Layout({ children, ...options }) {
  const { ctrl, layout: Kind } = useDocument();
  if (!ctrl || !Kind) return children ?? null;
  return <Kind {...options}>{children}</Kind>;
}

/**
 * What an entry renders when the app ships no view file. `children` come from
 * whoever mounts the entity (e.g. the contact_form element's Send button).
 */
export function DefaultView({ children }) {
  return <Layout>{children}</Layout>;
}
