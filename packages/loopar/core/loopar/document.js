import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import inflection from 'inflection';
import { documentManage } from '../document/document-manage.js';
import { loopar } from '../loopar.js';
import { Console } from './console.js';

const API_SUFFIX = '.api.js';
const apiModules = new Map(); // file -> Promise<module namespace>

export class Document extends Console {
  /**
   * What an entity exposes to other apps: the exports of `<entity>.api.js`
   * in the entity's own folder (`customer/customer.api.js`).
   *
   *   const { createCustomer } = await loopar.api('Customer');
   *
   * The entity is found by name, like `getDocument()`: the caller never
   * knows which app or module holds it. A record's own behavior stays on
   * its document (`getDocument()`); the api holds what works without one.
   * Only entities of the apps installed in this workspace answer.
   */
  async api(entity) {
    const ref = this.getRef(entity);
    const installed = new Set(['loopar', 'core', ...Object.keys(this.installedApps || {})
      .map((a) => inflection.transform(a, ['capitalize', 'dasherize']).toLowerCase())]);
    if (!ref || !installed.has(ref.__APP_KEY__)) {
      this.throw({ code: 404, message: `${entity}: not available in this workspace.` });
    }

    const file = path.join(this.pathRoot, ref.__ROOT__, `${path.basename(ref.__ROOT__)}${API_SUFFIX}`);
    if (!apiModules.has(file)) {
      apiModules.set(file, fs.existsSync(file) ? import(pathToFileURL(file).href) : Promise.resolve(null));
    }

    const api = await apiModules.get(file);
    if (!api) this.throw({ code: 404, message: `${ref.__NAME__} exposes no api (${path.basename(file)}).` });
    return api;
  }

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

  async getList(document, { data = {}, fields = null, filters = {}, orderBy = 'name', limit = 10, offset = 0, q = null, page = null, pageSize = 10, sort = null, rowsOnly = false, unscoped = false } = {}, ifNotFound = null) {
    const doc = await this.newDocument(document, data);
    return await doc.getList({ 
      pageSize,
      fields, 
      filters, 
      orderBy, limit, offset, page: page || loopar.getPage(document),
      sort,
      rowsOnly,
      unscoped,
      q 
    });
  }

  async getListToForm(document, { data = {}, fields = null, filters = {}, orderBy = 'name', limit = 10, offset = 0, q = null, page = null, sort = null, rowsOnly = false } = {}, ifNotFound = null) {
    const doc = await this.newDocument(document, data);
    return await doc.getListToForm({ 
      fields, 
      filters, 
      orderBy, 
      limit, offset, page: page || loopar.getPage(document),
      sort,
      rowsOnly,
      q
    });
  }
}