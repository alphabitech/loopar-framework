'use strict'

import express from "express";
import AuthController from "../auth/AuthController.js";
import { loopar } from "loopar";
import { titleize } from "inflection";
import {merge} from "es-toolkit/object";

export default class CoreController extends AuthController {
  defaultImporterFiles = ['index', 'form'];
  response = {};

  hasData() {
    return Object.keys(this.data || {}).length > 0;
  }

  exposeClientFiles() {
    loopar.server.use(express.static(loopar.makePath(loopar.pathRoot, this.controllerPath, "client")));
  }

  #actionMethod(action) {
    const name = loopar.utils.Capitalize(action);
    return this[`publicAction${name}`] && !this.isRevokedPublicAction(action)
      ? `publicAction${name}`
      : `action${name}`;
  }

  async sendAction(action) {
    const requested = action;
    action = this.#actionMethod(action);

    if (typeof this[action] !== 'function') {
      return await this.notFound({
        code: 404,
        title: "Action not found",
        description: `The action ${action} not found.`
      });
    }

    await this.beforeAction();

    // Authorization may downgrade the action (update → view for read-only users).
    if (this.action && this.action !== requested) action = this.#actionMethod(this.action);

    return await this[action]();
  }

  async notFound({code = 404, title = "Not Found", description = "The page you are looking for does not exist"} = {}) {
    const doc = await loopar.newDocument("Error");
    const document = await doc.__meta__();
    
    if(typeof arguments[0] === 'string') {
      code = "404";
      title = !arguments[1] ? "Not Found" : arguments[0];
      description = arguments[1] || arguments[0];
    }

    document.data = {
      code: code || 404,
      title: title || `Document ${titleize(this.document)} not found`,
      description: description || "The document you are looking for does not exist",
    };

    const isAjax = this.method === "POST" || this.req?.__WORKSPACE_NAME__ === "api";
    if (isAjax) {
      return document.data;
    }
    return await this.render(document);
  }

  async servePrivateFile(file) {
    await this.beforeAction();

    const document = await loopar.newDocument("File Manager", {
      name: file
    });

    const privateFile = await document.getPrivateFile();
    if (!privateFile) {
      return await this.notFound({
        code: 404,
        title: "Source not found",
        description: `The soruce ${file} not found.`,
      });
    }
    if (privateFile.error) {
      return await this.notFound({
        code: 403,
        title: "Access Denied",
        description: privateFile.error,
      });
    }
    if (privateFile.path) {
      const filePath = loopar.makePath(loopar.pathRoot, privateFile.path);
      if (filePath) {
        const fileName = privateFile.name || file;
        const fileType = privateFile.type || "application/octet-stream";
        const fileSize = privateFile.size || 0;
      }
    }

    document.data = { file }

    return await this.render(document);
  }

  /**
   * Returns a redirect payload for the client.
   * @param {string|null} url
   * @param {{ hard?: boolean }} [opts]
   */
  redirect(url = null, { hard = false } = {}) {
    return { redirect: url, hardRedirect: hard };
  }

  /**
   * Returns a raw-HTML payload: the router sends `body` as-is (text/html)
   * instead of running the workspace SSR. For tiny self-contained pages a
   * navigation endpoint must answer directly — e.g. the OAuth popup-close
   * page, which just postMessages the opener and closes itself.
   * Ignored on the AJAX channel (those requests always get JSON).
   */
  html(body, { status = 200 } = {}) {
    return { __RAW_HTML__: true, status, body, contentType: 'text/html' };
  }

  refresh(url = null) {
    if (url) return this.redirect(url, { hard: false });
    return { refresh: 'soft' };
  }

  reload(url = null) {
    if (url) return this.redirect(url, { hard: true });
    return { refresh: 'hard' };
  }

  async getError(code, { title = "Error", message = "An error occurred..", frame = null, stack = null } = {}) {
    const document = await loopar.newDocument("Error");

    return await this.render({
      ...await document.__meta__(),
      data: {
        code,
        title,
        message,
        ...(frame ? { frame } : {}),
        ...(stack ? { stack } : {}),
      }
    });
  }

  async render(meta, options={}) {
    if(meta.__meta__){
      meta = {
        //...meta,
        ...await meta.__meta__(),
        ...options,
      }
    }else{
      meta = {
        ...meta,
        ...options
      }
    }
    
    return merge(meta, {
      key: this.getKey(),
      instance: this.getInstance(),
      meta: {
        title: titleize((meta.title || this.name || this.document || "Document").toString()),
        action: this.action,
      },
      entry: this.clientEntry(meta),
      entryPoint: this.clientImporter(meta),
    });
  }

  /**
   * Client entry for this request: which document entry (`form` | `list` |
   * `view` | `page` | `report` | `auth` | `installer` | ...) mounts the
   * Document on the client (see src/document/entry/entries.js). The app's own
   * view (if any) renders inside it.
   *
   * Resolution: `this.entry` (explicit, when the entry differs from the view
   * file suffix — e.g. a list rendered by a `view` action) → `this.client` →
   * the `print` action → Page/View entities are `view` → by action.
   */
  clientEntry(Document) {
    if (!Document) return null;
    if (this.entry) return this.entry;
    if (this.client) return this.client;
    if (this.action === "print") return "print";
    if (["Page", "View", "Desk Page"].includes(Document.Entity?.type)) return "view";

    const action = this.action;
    if (['create', 'update'].includes(action)) return "form";
    if (['list', 'index'].includes(action)) return "list";
    return "view";
  }

  /**
   * Optional per-entity view module name (`<entity>-<suffix>`), where the
   * suffix is `this.client` or the action-derived kind. Apps only ship that
   * file when the view needs custom logic; otherwise the entry renders its default.
   */
  clientImporter(Document) {
    if (!Document) return null;
    const suffix = this.client || (this.action === "print" ? "print"
      : ["Page", "View", "Desk Page"].includes(Document.Entity?.type) ? "view"
      : ['create', 'update'].includes(this.action) ? "form"
      : ['list', 'index'].includes(this.action) ? "list" : "view");

    const name = Document.Entity.name;

    return `${loopar.utils.decamelize(name, { separator: '-' })}-${suffix}`
  }

  getKey(route = this.dictUrl) {
    return loopar.utils.urlHash(route);
  }

  getInstance(route = this.dictUrl) {
    return loopar.utils.urlInstance(route);
  }

  async actionSearch() {
    const document = await loopar.newDocument(this.document, { module: this.module });
    return await document.getListToSelectElement(this.q);
  }

  /**
   * Build a standard success response.
   * Always emits a `notify` (toast) by default; pass `notify: false` to suppress.
   */
  async success(message, options = {}) {
    const { notify, ...rest } = options;
    const text = message || "Success";

    const response = {
      status: 200,
      success: true,
      message: text,
      ...rest,
    };

    if (notify !== false) {
      response.notify = {
        type: notify?.type || "success",
        message: notify?.message || text,
      };
    }

    return response;
  }

  /**
   * Build a standard error response.
   * Always emits a `notify` (toast) by default; pass `notify: false` to suppress.
   */
  async error(message, options = {}, status) {
    const { notify, ...rest } = options;
    const text = message || "Error";

    const response = {
      status: status || 500,
      code: rest.code || 'INTERNAL_ERROR',
      title: rest.title || 'Error',
      message: text,
      ...rest,
    };

    if (notify !== false) {
      response.notify = {
        type: notify?.type || "error",
        message: notify?.message || text,
      };
    }

    return response;
  }
}