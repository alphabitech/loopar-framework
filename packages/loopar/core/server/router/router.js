'use strict';
import { loopar } from '../../loopar.js';
import { fileManage } from "../../file-manage.js";
import multer from "multer";
import { RouterUtils } from './router-utils.js';
import { merge } from 'es-toolkit/object';
import { Middleware } from "./middleware.js";
import { requestContext } from './request-context.js';

/**
 * Collects every plain-method name defined anywhere on a controller's
 * prototype chain. Setters/getters and the constructor are intentionally
 * left out — setters (e.g. `document`, `action`, `name` on AuthController)
 * are the standard way properties from `params` get assigned via
 * `Object.assign(this, props)`, so filtering them would break the framework.
 *
 * Results are cached per-class because the prototype chain is static.
 */
const __prototypeMethodsCache = new WeakMap();
function collectPrototypeMethods(cls) {
  if (!cls || typeof cls !== 'function') return new Set();
  const cached = __prototypeMethodsCache.get(cls);
  if (cached) return cached;

  const methods = new Set();
  let proto = cls.prototype;
  while (proto && proto !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === 'constructor') continue;
      const descriptor = Object.getOwnPropertyDescriptor(proto, name);
      if (descriptor && typeof descriptor.value === 'function') {
        methods.add(name);
      }
    }
    proto = Object.getPrototypeOf(proto);
  }

  __prototypeMethodsCache.set(cls, methods);
  return methods;
}

/**
 * Server router — pipeline order + controller dispatch.
 *
 * The pipeline STEPS and the response primitives (render/renderAjax/
 * redirect/throw) live in `Middleware` (the base class); this class owns
 * exactly two things:
 *   1. `route()` — the order in which the steps run.
 *   2. `makeController` / `executeController` — resolving the Document
 *      ref and executing the controller action (the hook the base
 *      pipeline expects).
 */
export default class Router extends Middleware {
  constructor(options) {
    super(options);
    // memoryStorage() with NO limits meant multer buffered files of arbitrary
    // size straight into RAM — in the single-core model one 2 GB upload takes
    // down the process that serves EVERY tenant. Cap file size, file count and
    // non-file field size. Generous enough for real uploads, bounded enough to
    // stop a memory-exhaustion DoS.
    this.uploader = multer({
      storage: multer.memoryStorage(),
      limits: {
        fileSize: 50 * 1024 * 1024,   // 50 MB per file
        files: 20,                    // at most 20 files per request
        fieldSize: 10 * 1024 * 1024,  // 10 MB per non-file field
      },
    }).any();
  }

  route() {
    this.server.use(
      this.setupAssetMiddleware(),
      this.setupNotFoundSourceMiddleware(),
      this.setupRouteMiddleware(),
      this.setupSiteDeskMiddleware(),
      this.setupBuildParamsMiddleware(),
      this.setupSystemMiddleware(),
      this.setupRateLimitMiddleware(),
      this.setupWorkspaceMiddleware(),
      this.setupControllerMiddleware(),
      this.setupFinalMiddleware()
    );

    this.server.use(this.setupErrorMiddleware());
  }

  /**
   * Creates and executes controller
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   */
  async makeController(req, res, next) {
    const params = req.__params__;

    const setDocument = (validate=true) => {
      if (RouterUtils.workspaceServesWebPages(req.__WORKSPACE_NAME__)) {
        const webApp = loopar.webApp;
        if (!webApp?.name) {
          return loopar.throw({
            code: 404,
            message: "The web app has not yet been set up in System Settings."
          });
        }
        
        const requestedLink = params.document ?? webApp.menu_items?.[0]?.link;
        const menu = RouterUtils.RouteParsing.findWebAppMenu(requestedLink, loopar);

        if (menu) {
          params.document = menu.page;
        }else if (validate){
          return loopar.throw({ code: 404, message: "Page not found" });
        }
        
      }
    }

    if (req.__ROUTE_MODE__ === "rpc") {
      setDocument(false);
      if (!params.document || !params.action) {
        return loopar.throw({
          code: 404,
          message: `Invalid RPC route "${req._parsedUrl.pathname}" — expected /{Document}/{action}.`
        });
      }
    } else {
      RouterUtils.setDefaultParams(params, req.__WORKSPACE_NAME__);
      setDocument();
    }

    const ref = loopar.getRef(loopar.utils.Capitalize(params.document), false);

    if (!ref) {
      loopar.throw({
        code: 404,
        message: `Document ${params.document} not found.`
      });
    }

    params.document = ref.__NAME__;

    return await this.executeController(req, res, next, params, ref);
  }

  /**
   * Executes controller logic
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Object} params - Request parameters
   * @param {Object} ref - Document reference
   */
  async executeController(req, res, next, params, ref) {
    const makeController = async (query, body) => {
      const parsedQuery = RouterUtils.parseQuery(query);

      const C = await fileManage.importClass(
        loopar.makePath(ref.__ROOT__, `${params.document}Controller.js`)
      );

      const data = RouterUtils.prepareFileData(body, req.files);

      // List state (filters + page) persisted per Document. Readers use the
      // bare `${document}q` / `${document}page` keys (document.js,
      // base-document.js, base-controller.js)
      if(data && (data.q || data.page)){
        loopar.session.set(`${req.__WORKSPACE_NAME__}${params.document}q`, data.q || {});
        loopar.session.set(`${req.__WORKSPACE_NAME__}${params.document}page`, data.page || 1);
      }

      // Filter parsedQuery to avoid shadowing controller methods. A URL like
      // `?redirect=/desk` would otherwise assign `this.redirect = "/desk"` and
      // clobber the `CoreController.redirect()` method that actions rely on.
      // The full raw query is still available on `this.query` so callers can
      // read `this.query.redirect` when they need the URL value.
      const reservedNames = collectPrototypeMethods(C);
      const safeSpreadQuery = {};
      for (const [k, v] of Object.entries(parsedQuery)) {
        if (!reservedNames.has(k)) safeSpreadQuery[k] = v;
      }

      const Controller = new C({
        ...params,
        ...safeSpreadQuery,
        query: parsedQuery,
        data,
        body: data,
        __REQ_FILES__: req.files,
        enabledActions: C.enabledActions,
        freeActions: C.freeActions,
        __WORKSPACE__: req.__WORKSPACE_NAME__
      });

      const action = params.action?.length > 0 ? params.action : Controller.defaultAction;
      Controller.action = action;
      // Record-level scope (auth/record-scope.js) reads the request's
      // controller to narrow lists of the requested document to the user's own.
      req.__CONTROLLER__ = Controller;

      const result = await Controller.sendAction(action) || {};

      if (result) {
        // Terminal payloads (redirect / raw HTML from `CoreController.html()`)
        // must stay top-level: the controller middleware inspects
        // `req.__WORKSPACE__` directly — merging them under `Document`
        // would bury the marker and fall through to the workspace SSR.
        if (RouterUtils.isAjaxRequest(req) || (typeof result == "object" && (result.redirect || result.__RAW_HTML__))) {
          req.__WORKSPACE__ = result;
        } else {
          req.__WORKSPACE__ = merge(
            req.__WORKSPACE__ || {},
            {
              Document: merge(
                result,
                {
                  meta: {
                    module: ref?.module
                  }
                }
              )
            }
          );
        }
      }
    };

    const contentType = req.headers['content-type'];
    const isMultipart = RouterUtils.isMultipartFormData(contentType);

    if (isMultipart) {
      // Multer's callback breaks the AsyncLocalStorage chain, so we re-enter
      // the context below. Capture the CURRENT store first (while it's still
      // live) so the re-run preserves everything it carried — notably the
      // resolved tenant — instead of rebuilding a partial {req,res} store.
      const parentContext = requestContext.getStore() || {};

      return new Promise((resolve, reject) => {
        this.uploader(req, res, async err => {
          if (err) {
            reject(err);
            return;
          }

          try {
            requestContext.run({ ...parentContext, req, res }, async () => {
              try {
                resolve(await makeController(req.query, req.body));
              } catch (controllerErr) {
                reject(controllerErr);
              }
            });
          } catch (controllerErr) {
            reject(controllerErr);
          }
        });
      });
    }

    return await makeController(req.query, req.body);
  }
}