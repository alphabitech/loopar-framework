import { loopar } from '../loopar.js';
import { fileManage } from "../file-manage.js";
import { parseDocStructure } from "./tools.js";

class DocumentManage {
  constructor(props) {
    Object.assign(this, props);
  }

  async getDocument(document, name, data = null, {ifNotFound = 'throw', parse=false, requestContext=null}={}) {
    const ENTITY = await this.#GET_ENTITY(document, requestContext);
    // Without a name a record can't be found: looking it up would return the
    // first row (opened as a new record, then saved as a duplicate).
    const missingName = !ENTITY.is_single && (name === undefined || name === null || name === '');
    const databaseData = missingName ? null : await loopar.db.getDoc(ENTITY, name, ENTITY.__REF__.__FIELDS__);

    if (databaseData) {
      // Pass the pre-parsed ENTITY through so newDocument doesn't trigger
      // a second parseDocStructure pass (which would re-execute side
      // effects like COLLECTION preload — losing the requestContext).
      return await this.newDocument(document, { ...databaseData, ...(data || {}) }, name, parse, ENTITY);
    } else {
      if(ENTITY.is_virtual){
        return await this.newDocument(document, data, name, parse, ENTITY, ifNotFound);
      }

      if (ifNotFound === 'new') {
        return await this.newDocument(document, data, name, parse, ENTITY);
      }

      if (ifNotFound === 'throw') {
        loopar.throw({ code: 404, message: `${ENTITY.name} ${name}: not found` });
      }

      return ifNotFound;
    }
  }

  async newDocument(document, data = {}, name, parse = false, preParsedEntity = null, ifNotFound) {
    // Reuse the ENTITY when the caller already parsed it (carrying the
    // request-scoped state in field.data.preloaded). Falls back to a
    // fresh parse for standalone callers — which is the original behaviour.
    const ENTITY = preParsedEntity || await this.#GET_ENTITY(document);
    const DOCUMENT = await this.#importDocument(ENTITY);
    const spacing = loopar.__installed__ && ENTITY.__REF__.is_child != 1 ?
      await loopar.db.getDoc("App", ENTITY.__REF__.__APP__, ["gap", "col_padding"]) : {};

    const instance = await new DOCUMENT({
      __ENTITY__: ENTITY,
      __DOCUMENT_NAME__: name,
      __DATA__: data || {},
      __IS_NEW__: !name,
      __SPACING__: spacing || {gap: 1, col_padding: "p-0"}
    });

    const result = await instance.__init__(ifNotFound);
    return result === undefined ? instance : result;
  }

  async #GET_ENTITY(document, requestContext = null) {
    const throwError = (type) => {
      loopar.throw({
        code: 404,
        message: `${(type || "Entity")}: ${document} not found`,
      });
    }

    let ENTITY = null;

    const ref = loopar.getRef(document);
    if (!ref) return throwError();

    const entityName = ref.__ENTITY__;

    /**Testing get fileRef only */
    ENTITY = fileManage.getConfigFile(document, ref.__ROOT__);

    if (!ENTITY) return throwError(entityName);

    if (ENTITY.doc_structure) {
      if (Array.isArray(ENTITY.doc_structure)) {
        ENTITY.doc_structure = JSON.stringify(ENTITY.doc_structure);
      }

      ENTITY.doc_structure = JSON.stringify(
        await parseDocStructure(loopar.utils.JSONparse(ENTITY.doc_structure, ENTITY.doc_structure), true, document, requestContext, ref.__APP__)
      );
    }

    ENTITY.is_single ??= ref.is_single;
    ENTITY.__REF__ = ref;
    return ENTITY;
  }

  async #importDocument(ENTITY) {
    const documentPathFile = loopar.makePath(ENTITY.__REF__.__ROOT__, `${ENTITY.name}.js`);

    return fileManage.importClass(documentPathFile, (e) => {
      console.log("importDocument err", e);
      loopar.throw({ code: 404, message: `Document ${ENTITY.name} not found` });
    });
  }
}

export const documentManage = new DocumentManage({})