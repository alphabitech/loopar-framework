import loopar from "loopar";
import { scrollMemory } from "@@tools/router/scroll-memory";
import DocumentHistory from "../../components/document-history.jsx";
import { createFieldStore } from "./field-store";

/**
 * Controller of an entry (plain JS, no React): structure lookup, field store,
 * document history, scroll placement. `env` = { props (live) }.
 * Instantiated once per mount by `useController`; reachable as `useDocument().ctrl`.
 */
export class DocumentController {
  #env;
  #cachedStructureSrc;
  #cachedStructure;
  #cachedFields;
  #cachedFieldByName;

  fields = createFieldStore();

  constructor(env) {
    this.#env = env;
  }

  get props() {
    return this.#env.props;
  }

  get Document() {
    return this.props.Document || {};
  }

  get __META__() {
    return this.props.__META__ || {};
  }

  get __IS_NEW__() {
    return this.Document.isNew;
  }

  get __DOCUMENT_NAME__() {
    return this.__META__.__DOCUMENT_NAME__;
  }

  get __ENTITY__() {
    return this.__META__.Entity || {};
  }

  /** Ref of a rendered field (component instance or field data). */
  get(name) {
    return this.fields.getRef(name);
  }

  /** Parsed structure, memoized on its source string (derived caches follow). */
  get __STRUCTURE__() {
    const explicit = this.Document.STRUCTURE;
    const docStructure = this.Document.Entity?.doc_structure ?? "[]";
    const src = explicit ?? docStructure;

    if (this.#cachedStructureSrc === src && this.#cachedStructure !== undefined) {
      return this.#cachedStructure;
    }

    this.#cachedStructureSrc = src;
    this.#cachedStructure = explicit ?? JSON.parse(docStructure);
    this.#cachedFields = undefined;
    this.#cachedFieldByName = undefined;
    return this.#cachedStructure;
  }

  get __FIELDS__() {
    if (this.#cachedFields !== undefined) return this.#cachedFields;

    const mapFields = (fields) => fields.reduce((acc, field) => {
      acc.push({ data: field.data, def: ELEMENT_DEFINITION(field.element) });
      if (field.elements) return acc.concat(mapFields(field.elements));
      return acc;
    }, []);

    this.#cachedFields = mapFields(this.__STRUCTURE__);
    return this.#cachedFields;
  }

  get __WRITABLE_FIELDS__() {
    return this.__FIELDS__.filter(field => field.def?.isWritable);
  }

  get __READONLY_FIELDS__() {
    return this.__FIELDS__.filter(field => [1, "1", true].includes(field.data.readonly) || field.data.write_policy === "display_only");
  }

  __FIELD__(fieldName) {
    if (this.#cachedFieldByName === undefined) {
      this.#cachedFieldByName = new Map();
      for (const field of this.__FIELDS__) {
        if (field.data?.name) this.#cachedFieldByName.set(field.data.name, field);
      }
    }
    return this.#cachedFieldByName.get(fieldName);
  }

  /* setMetaDefinition*/
  setFieldDf(fieldName, attr, value) {
    this.fields.setMetaData(fieldName, attr, value);
  }

  on(fieldName, event, callback) {
    this.fields.on(fieldName, event, callback);
  }

  getDocumentHistory(isPage) {
    const entity = this.Document?.Entity || {};
    const enableHistory = loopar.utils.trueValue(entity.enable_history);
    const enableComments = loopar.utils.trueValue(entity.enable_comments);
    if (!enableHistory && !enableComments) return null;

    const documentType = entity.name;
    const documentName = isPage ? documentType : (this.__DOCUMENT_NAME__ || this.Document?.name);

    // A new record has no history or comments yet.
    if (!documentType || !documentName || (!isPage && this.Document?.isNew)) return null;

    return (
      <section className="mt-10 pt-6 border-t border-border w-full max-w-3xl">
        <DocumentHistory
          document={documentType}
          documentName={documentName}
          enableHistory={enableHistory}
          enableComments={enableComments}
          requireLogin={loopar.utils.trueValue(entity.require_login_to_comment)}
          canModerate
        />
      </section>
    );
  }

  /**
   * The entry's content is mounted: top of the page after a link, the saved
   * position after back/forward or a reload (see tools/router/scroll-memory).
   */
  initScroll() {
    if (this.props.inModal) return;
    scrollMemory.settle();
  }

  mount() {
    this.initScroll();
  }

  unmount() {}
}
