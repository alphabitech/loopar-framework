import { documentManage } from '../document/document-manage.js';
import { loopar } from '../loopar.js';
import { Console } from './console.js';

export class Document extends Console {
  async getEntity(entity, data = null, { ifNotFound = 'throw', parse = false } = {}) {
    const ref = this.getRef(entity);

    return await documentManage.getDocument(ref.__ENTITY__, ref.__NAME__, data, { ifNotFound, parse });
  }

  /**
   * 
   * @param {*} document DocumentType name
   * @param {*} name Document name
   * @param {*} data
   * @param {*} ifNotFound
   * @returns 
   */
  async getDocument(document, name, data = null, { ifNotFound = 'throw', parse = false, requestContext = null } = {}) {
    return await documentManage.getDocument(document, name, data, { ifNotFound, parse, requestContext });
  }

  /**
   * 
   * @param {*} document 
   * @param {*} data 
   * @returns 
   */
  async newDocument(document, data = {}) {
    return await documentManage.newDocument(document, data);
  }

  async deleteDocument(document, name, { sofDelete = true, force = false, ifNotFound = null } = {}) {
    const Doc = await this.getDocument(document, name);
    await Doc.delete({ sofDelete, force });
  }

  async getList(document, { data = {}, fields = null, filters = {}, orderBy = 'name', limit = 10, offset = 0, q = null, page = null, rowsOnly = false, unscoped = false } = {}, ifNotFound = null) {
    const doc = await this.newDocument(document, data);
    return await doc.getList({ 
      fields, 
      filters, 
      orderBy, limit, offset, page: page || loopar.getPage(document),
      rowsOnly,
      unscoped,
      q 
    });
  }

  async getListToForm(document, { data = {}, fields = null, filters = {}, orderBy = 'name', limit = 10, offset = 0, q = null, page = null, rowsOnly = false } = {}, ifNotFound = null) {
    const doc = await this.newDocument(document, data);
    return await doc.getListToForm({ 
      fields, 
      filters, 
      orderBy, 
      limit, offset, page: page || loopar.getPage(document),
      rowsOnly,
      q
    });
  }
}