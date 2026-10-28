import fs from 'fs';
import crypto from 'crypto';
import path from 'pathe';
import { loopar } from '../../loopar.js';
import { RouterUtils } from './router-utils.js';
import { safeReturnPath } from '../../global/router-utils.js';
import { verifyWorkspaceToken } from '../../auth/workspace-token.js';
import { getTenant } from './request-context.js';
import WorkspaceController from '../../controller/workspace-controller.js';
import { getHttpError } from '../../global/http-errors.js';
import { mayReadPrivateFile } from '../../global/private-files.js';
import BaseController from '../../controller/base-controller.js';
import { merge } from 'es-toolkit/object';
import rateLimit from 'express-rate-limit';
import { RedisStore as RateLimitRedisStore } from 'rate-limit-redis';
import { redisEnabled, createRedisClient } from '../../redis/redis-client.js';

export class Middleware {
  constructor(options) {
    Object.assign(this, options);
  }

  /**
   *   navigation → workspace from the URL (GET) or from the explicit
   *                `workspace` param of the SPA's document fetch (POST).
   *   rpc        → workspace from the signed X-Workspace-Token header;
   *                the URL is just /{Document}/{action}.
   *
   * Every later step reads `req.__ROUTE_MODE__` / `req.__WORKSPACE_NAME__`
   * instead of re-reading the URL to guess either of them.
   *
   * @returns {Function} Middleware function
   */
  setupRouteMiddleware() {
    return (req, res, next) => {
      const route = RouterUtils.resolveRequestRoute(req, verifyWorkspaceToken);
      req.__ROUTE_MODE__ = route.mode;
      req.__WORKSPACE_NAME__ = route.workspace;
      req.__IS_AJAX__ = RouterUtils.isAjaxRequest(req);
      next();
    };
  }

  setupSiteDeskMiddleware() {
    return (req, res, next) => {
      if (req.__WORKSPACE_NAME__ !== 'desk' || !getTenant()?.webApp) return next();
      const err = new Error('Not found');
      Object.assign(err, { status: 404, code: 404, title: 'Not found' });
      return next(err);
    };
  }

  /**
   * Sets up system validation middleware.
   *
   * @returns {Function} Middleware function
   */
  setupSystemMiddleware() {
    return async (req, res, next) => {
      const currentUrlLower = req._parsedUrl.pathname.toLowerCase();
      const status = RouterUtils.SystemValidation.getStatus(loopar);

      // The System controller must stay reachable while the framework is
      // still half-installed — it's how the bootstrap pages submit, and it
      // guards itself (`static publicActions` + the install token).
      //
      // Asked as a ROUTE question — "is this an RPC to the System
      // document?" — instead of matching url prefixes. One check now
      // covers every channel, because the workspace segment (if the caller
      // sent one) was already resolved away upstream:
      //   - client: /System/connect (loopar.call("System", …))
      //   - server-to-server: /api/System/install
      const isSystemRpc =
        req.__ROUTE_MODE__ === "rpc" &&
        String(req.__params__?.document || '').toLowerCase() === 'system';

      // A system-state redirect must NEVER be a 302 on the AJAX channel:
      // fetch() follows it silently (POST→GET, keeping X-Requested-With /
      // X-Workspace-Token), the redirected page is then served as JSON meta
      // and the SPA renders ANOTHER document under the unchanged URL (e.g.
      // Desk welcome on /desk/App Manager/view after a discard restarts the
      // tenant). Ship the redirect inside the JSON instead — http.jsx does a
      // hard window.location.replace, so URL and content stay in sync.
      const sendRedirect = (url) => {
        if (RouterUtils.isAjaxRequest(req)) {
          return this.renderAjax(res, { redirect: url, hardRedirect: true });
        }
        return this.redirect(req, res, url);
      };

      if (!isSystemRpc) {
        const requiredPath = RouterUtils.SystemValidation.getRedirectPath(loopar);

        if (requiredPath) {
          if (currentUrlLower !== requiredPath.toLowerCase()) {
            if (RouterUtils.isAjaxRequest(req)) {
              // An AJAX call comes from an app that was already running, so
              // "needs connect/install/update" is almost always TRANSIENT
              // (tenant re-init, an in-process loopar.build() during an app
              // install/reinstall, a busy DB). Redirecting sent the user to
              // the system page — "spent" a moment later — and from there to
              // /desk. Answer a retryable 503 instead: the SPA retries the
              // navigation; a real page load (GET) still gets the redirect.
              console.warn(`[system] ${req.method} ${req.originalUrl} → 503 (state requires ${requiredPath})`);
              return this.renderAjax(res, {
                status: 503,
                code: 503,
                title: 'Service Unavailable',
                message: 'The system is starting or updating. Please try again in a moment.',
                retryable: true,
                // Where a full page load would go, if the state persists.
                requires: requiredPath,
              });
            }
            // Carry the page the user was on, so finishing the update brings
            // them back there instead of to the default landing.
            const back = safeReturnPath(req.originalUrl);
            console.warn(`[system] GET ${req.originalUrl} → ${requiredPath}`);
            return this.redirect(req, res, back ? `${requiredPath}?redirect=${encodeURIComponent(back)}` : requiredPath);
          }
        } else {
          const spentPages = [status.connectPath, status.installPath, status.updatePath]
            .map((path) => path.toLowerCase());
          if (spentPages.includes(currentUrlLower)) {
            return sendRedirect(safeReturnPath(req.query?.redirect) || '/desk');
          }
        }
      }

      if (
        status.isFullyInstalled &&
        req.__WORKSPACE_NAME__ === "loopar" &&
        req.__ROUTE_MODE__ === "navigation"
      ) {
        return sendRedirect('/desk');
      }

      next();
    };
  }

  /**
   * Sets up workspace middleware
   * @returns {Function} Middleware function
   */
  setupWorkspaceMiddleware() {
    return async (req, res, next) => {
      // No HTML workspace UI for AJAX channels (POST or /api/* of any verb).
      if (RouterUtils.isAjaxRequest(req)) return next();

      const Controller = new WorkspaceController({
        req,
        res,
        method: req.method
      });
      Controller.dictUrl = req._parsedUrl;
      Controller.workspace = req.__WORKSPACE_NAME__;

      req.__APP__ = Controller;
      req.__WORKSPACE__ = await Controller.getWorkspace();
      next();
    };
  }

  /**
   * Sets up parameter building middleware
   * @returns {Function} Middleware function
   */
  setupBuildParamsMiddleware() {
    return (req, res, next) => {
      req.__WORKSPACE__ ??= {};
      const url = req._parsedUrl;
      const isRpc = req.__ROUTE_MODE__ === "rpc";

      const routeStructure = isRpc
        ? RouterUtils.RouteParsing.parseRpcParams(url.pathname)
        : RouterUtils.RouteParsing.parseParams(url.pathname, req.__WORKSPACE_NAME__);

      // Keep the full path unless the workspace declares that its
      // navigation urls are prefixed with the workspace segment
      // (`urlPrefixed` in WORKSPACE_CAPABILITIES). RPC urls are never
      // prefixed, whatever the workspace context is.
      const stripPrefix = !isRpc && RouterUtils.workspaceIsUrlPrefixed(req.__WORKSPACE_NAME__);

      const controllerParams = {
        req,
        res,
        dictUrl: url,
        pathname: stripPrefix
          ? url.pathname.split("/").slice(1).join("/")
          : url.pathname,
        method: req.method
      };

      if (RouterUtils.workspaceServesWebPages(req.__WORKSPACE_NAME__)) {
        routeStructure.action ??= "view";
        controllerParams.action = routeStructure.action;
      }

      req.__params__ = { ...routeStructure, ...controllerParams };

      next();
    };
  }

  /**
   * Sets up controller middleware
   * @returns {Function} Middleware function
   */
  setupControllerMiddleware() {
    return async (req, res, next) => {
      await this.makeController(req, res, next);
      const response = req.__WORKSPACE__;

      // AJAX channel (POST or /api/*) NEVER emits a 302 — would make fetch
      // follow it and the client end up navigating to the wrong place. The
      // redirect URL travels inside the JSON.
      if (RouterUtils.isAjaxRequest(req)) {
        return this.renderAjax(res, response);
      }

      if (response?.redirect) {
        return this.redirect(req, res, response.redirect);
      }

      // Raw-HTML payload from `CoreController.html()` — send it as-is and
      // skip the workspace SSR (used by self-contained pages like the OAuth
      // popup-close page). Only reachable on navigation: the AJAX branch
      // above already returned.
      if (response?.__RAW_HTML__) {
        return this.render(req, res, response);
      }

      next();
    };
  }

  /**
   * Sets up final rendering middleware
   * @returns {Function} Middleware function
   */
  setupFinalMiddleware() {
    return async (req, res) => {
      this.render(req, res, await req.__APP__.render(req.__WORKSPACE__));
    };
  }

  /**
   * Sets up asset detection middleware
   * @returns {Function} Middleware function
   */
  setupAssetMiddleware() {
    return (req, res, next) => {
      req.isAssetUrl = RouterUtils.isAssetUrl(req._parsedUrl.pathname);
      next();
    };
  }

  /**
   * Sets up not found source middleware.
   *
   * @returns {Function} Middleware function
   */
  setupNotFoundSourceMiddleware() {
    return async (req, res, next) => {
      if (req._parsedUrl.pathname.startsWith('/assets/private/')) {
        return await this.#servePrivateAsset(req, res);
      }
      if (!req.isAssetUrl) return next();

      try {
        const target = await this.#resolveRemoteAsset(req._parsedUrl.pathname);
        if (target) {
          return res.redirect(302, target);
        }
      } catch (err) {
        console.warn('[asset middleware] remote lookup failed:', err?.message || err);
      }

      const errString = this.errTemplate({
        code: 404,
        title: "Source not found",
        description: req.url
      });

      res
        .status(404)
        .set('Content-Type', 'text/html')
        .send(errString);
    };
  }

  /**
   * Map a `/assets/public/...` path back to its real delivery URL when
   * the binary lives outside the local filesystem.
   *
   * Resolution is filesystem-only: the asset's mirror file
   * (`{name}.meta.json`) lives in the same roots `express.static` serves.
   *
   * Scope is intentionally narrow: only URLs under `/assets/public/`
   * (with an optional `/thumbnails/` segment) are resolved. Any other 404
   * stays a 404.
   */
  async #resolveRemoteAsset(pathname) {
    // Private files never get here: #servePrivateAsset answers them.
    const m = pathname.match(/^\/assets\/public\/(thumbnails\/)?(.+)$/);
    if (!m) return null;
    const isThumb = !!m[1];
    const filename = decodeURIComponent(m[2]);
    if (!filename || filename.includes('/')) return null;

    return await this.#resolveFromMirror(filename, 'public', isThumb);
  }

  /**
   * Private files (`/assets/private/{name}`, `/assets/private/thumbnails/{name}`):
   * served only to a signed-in user who may open them (see private-files.js:
   * the record they belong to, soft-deleted records…). Anything else gets the
   * same 404 as a missing file.
   */
  async #servePrivateAsset(req, res) {
    const notFound = () => res.status(404).set('Content-Type', 'text/html')
      .send(this.errTemplate({ code: 404, title: "Source not found", description: req.url }));

    const m = req._parsedUrl.pathname.match(/^\/assets\/private\/(thumbnails\/)?([^/]+)$/);
    if (!m) return notFound();
    let filename;
    try { filename = decodeURIComponent(m[2]); } catch { return notFound(); }
    if (!filename || filename.includes('/') || filename.includes('\\') || filename.startsWith('.')) return notFound();
    const isThumb = !!m[1];

    const user = this.#hasSession() ? loopar.auth.user() : null;
    if (!user) return notFound();

    for (const root of loopar.getAssetRoots('private')) {
      let meta;
      try { meta = JSON.parse(await fs.promises.readFile(path.join(root, `${filename}.meta.json`), 'utf8')); } catch { continue; }
      if (!await mayReadPrivateFile(meta, user)) return notFound();

      if ((meta.storage_driver || 'local') !== 'local') {
        const target = isThumb ? (meta.previewSrc || meta.src) : meta.src;
        return target ? res.redirect(302, target) : notFound();
      }

      const filePath = path.join(root, isThumb ? 'thumbnails' : '', filename);
      if (!fs.existsSync(filePath)) return notFound();

      const type = String(meta.type || '');
      const inline = type === 'image' || filename.toLowerCase().endsWith('.pdf');
      res.set({
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        // Whatever the file holds, it never runs as a page of this site.
        'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
      });
      // The visible name, without the random prefix of the stored one.
      const shown = filename.replace(/^[0-9a-f]{24}-/, '');
      res.attachment(shown);
      if (inline) res.set('Content-Disposition', `inline; filename="${encodeURIComponent(shown)}"`);
      return res.sendFile(filePath);
    }
    return notFound();
  }

  /** True when the request carries a valid login session (tenant context). */
  #hasSession() {
    try {
      return !!loopar.auth?.user?.();
    } catch {
      return false;
    }
  }

  /**
   * Find a `{filename}.meta.json` in any of the asset roots and pull
   * the delivery URL out of it. The mirror is the cheap path — a
   * filesystem stat + small JSON parse.
   * @param {string} filename - The filename to resolve
   * @param {string} visibility - The visibility of the asset
   * @param {boolean} isThumb - Whether the asset is a thumbnail
   * @returns {Promise<string|null>} The delivery URL or null if not found
   */
  async #resolveFromMirror(filename, visibility, isThumb) {
    const roots = loopar.getAssetRoots ? loopar.getAssetRoots(visibility) : [];
    for (const root of roots) {
      const mirrorPath = path.join(root, `${filename}.meta.json`);
      let raw;
      try {
        raw = await fs.promises.readFile(mirrorPath, 'utf8');
      } catch (err) {
        if (err?.code !== 'ENOENT') {
          console.warn('[asset middleware] mirror read failed:', mirrorPath, err?.message);
        }
        continue;
      }
      let meta;
      try { meta = JSON.parse(raw); } catch { continue; }
      if (!meta?.src) continue;

      if (isThumb && meta.storage_driver === 'local') {
        return meta.src;
      }
      return isThumb ? (meta.previewSrc || meta.src) : meta.src;
    }
    return null;
  }

  /**
   * Sets up global error handling middleware
   * @returns {Function} Error middleware function
   */
  setupErrorMiddleware() {
    return async (err, req, res, next) => {
      try {
        loopar.db && (await loopar.db.safeRollback());
      } catch (rollbackErr) {
        console.error("Rollback failed:", rollbackErr);
      }

      if (!res || res.headersSent) return;

      const redirect = err?.redirect;
      const original = err;
      err = getHttpError(err);

      // Production: an unexpected 5xx (SQL, driver, TypeError…) must not leak
      // its raw message to the browser — it can carry table structure, SQL and
      // record data. The client gets a generic message plus a reference; the
      // full detail stays in the core log under that same reference.
      // Errors raised on purpose via loopar.throw() are marked `expose`.
      let ref = null;
      if (Number(err.status) >= 500 && process.env.NODE_ENV === 'production' && !original?.expose) {
        ref = crypto.randomBytes(4).toString('hex');
        err = {
          ...err,
          title: 'Unexpected error',
          message: `Something went wrong while processing your request. Reference: ${ref}`,
        };
        delete err.frame;
        delete err.stack;
      }

      // Always leave a trace in the core log: the browser only gets the
      // normalised payload, and a 5xx with no server-side line is
      // undebuggable. 4xx are expected traffic — one line, no stack.
      if (Number(err.status) >= 500) {
        console.error(
          `[${err.status}]${ref ? ` [ref ${ref}]` : ''} ${req.method} ${req.originalUrl || req.url} — ${original?.message ?? err.message}`,
          original instanceof Error ? `\n${original.stack}` : (err.stack ? `\n${err.stack}` : ''),
        );
      } else if (process.env.NODE_ENV !== 'production') {
        console.warn(`[${err.status}] ${req.method} ${req.originalUrl || req.url} — ${err.message}`);
      }

      try {
        if (RouterUtils.isAjaxRequest(req)) {
          // Surface redirect (if any) inside the JSON so the client can
          // navigate after handling the error UX.
          return this.renderAjax(res, redirect ? { ...err, redirect } : err);
        }

        if (redirect && req._parsedUrl.pathname !== redirect) {
          return this.redirect(req, res, redirect);
        }

        const errControlled = new BaseController({ req, res });
        errControlled.dictUrl = req._parsedUrl;
        const e = await errControlled.getError(err.code, err);

        req.__WORKSPACE__ = merge(
          req.__WORKSPACE__ || {},
          {
            Document: {
              ...e,
              meta: {
                title: err.title
              },
              entryPoint: "error-view",
            }
          }
        );

        // `getError()` runs through render(), which assigns a client entry
        // ("view"). Inside <Entry> the view is mounted as a bare child and
        // never receives `Document` as a prop, so ErrorView rendered with
        // empty data ("An error occurred", no message, no stack). The error
        // view is standalone by design (see AppSourceLoader): drop the entry.
        delete req.__WORKSPACE__.Document.entry;

        // The error can fire before the workspace middleware ran (asset 404s,
        // body-parser failures…), in which case there is no per-request App
        // to render with — fall back to the bare HTML error template.
        if (!req.__APP__) return this.throw(err, res);

        return this.render(req, res, await req.__APP__.render(req.__WORKSPACE__, true));
      } catch (renderErr) {
        console.error('[500] error page itself failed to render:', renderErr);
        return this.throw(renderErr, res);
      }
    };
  }

  setupRateLimitMiddleware() {
    const minutes = 15;
    // Global limit across workers: with Redis the counter is shared, so N
    // cluster workers enforce ONE 15/window budget. Without Redis each worker
    // counts alone (limit x N) \u2014 fine single-process, weak in cluster.
    let store;
    if (redisEnabled()) {
      const client = createRedisClient();
      if (client) {
        store = new RateLimitRedisStore({
          prefix: 'rl:login:',
          sendCommand: (...args) => client.call(...args),
        });
      }
    }
    const loginLimiter = rateLimit({
      windowMs: minutes * 60 * 1000,
      max: 15,
      standardHeaders: true,
      legacyHeaders: false,
      ...(store ? { store } : {}),
      handler: (req, res) => {
        res.status(429).json({
          status: 429,
          code: 'RATE_LIMITED',
          title: 'Too Many Requests',
          message: `Too many login attempts, try again in ${minutes} minutes`
        });
      },
    });
  
    return (req, res, next) => {
      // Matched on the PARSED route, not on the url. `/Auth/login` (rpc)
      // and the legacy `/auth/login` post both parse to the same
      // document/action pair, so one check covers both without naming a
      // single url.
      const doc = String(req.__params__?.document || '').toLowerCase();
      const action = String(req.__params__?.action || '').toLowerCase();

      // Limit every unauthenticated auth action that can be abused for
      // brute force, user enumeration or email flooding — not just login.
      const RL_ACTIONS = new Set([
        'login', 'register',
        'recoverypasswordrequest', 'recoverypassword',
        'recoveryuser', 'mfaverify',
      ]);
      const isRateLimited = req.method === 'POST' && doc === 'auth' && RL_ACTIONS.has(action);

      if (!isRateLimited) return next();
      return loginLimiter(req, res, next);
    };
  }

  /**
   * Renders an HTML response.
   */
  render(req, res, response) {
    if (res.headersSent) return;

    if (response instanceof Error) {
      res.status(500).set('Content-Type', 'text/html').send(response.message);
      return;
    }

    if (!response || typeof response !== 'object') {
      res.status(500).set('Content-Type', 'text/html').send('Invalid response');
      return;
    }

    res.status(response.status || 200)
      .set('Content-Type', response.contentType || 'text/html')
      .set('Cache-Control', 'no-cache')
      .send(response.body ?? '');
  }

  /**
   * Renders AJAX/JSON response with a single, stable wire shape.
   *
   * Error responses (status >= 400): { status, success: false, code, title, message }
   * Success responses: { status, success: true, message?, notify?, ...payload }
   *
   * `success` is ALWAYS derived from the HTTP status — whatever the handler put
   * there is overwritten. A negative domain outcome that is not a request failure
   * goes in a domain field (available: false, state: 'failed', …), never `success`.
   *
   */
  renderAjax(res, response) {
    if (res.headersSent) return;

    if (!response) {
      console.error('Error: Empty response received');
      return;
    }

    const headers = {
      'Content-Type': 'application/json'
    };

    if (response instanceof Error) {
      res.status(500).set(headers).json({
        status: 500,
        success: false,
        code: response.code || 'INTERNAL_ERROR',
        title: response.title || 'Internal Server Error',
        message: response.message || 'An unexpected error occurred'
      });
      return;
    }

    if (typeof response === 'string') {
      res.status(200).set(headers).json({ status: 200, success: true, message: response });
      return;
    }

    // Raw data payloads (actions returning a list) go out as-is: spreading an
    // array into the envelope turns it into { 0: …, 1: …, status, success }
    // and the client loses the array (e.g. getUserRoles → data.map crash).
    if (Array.isArray(response)) {
      res.status(200).set(headers).json(response);
      return;
    }

    const raw = Number(response.status) || Number(response.code) || 200;
    const status = (raw >= 100 && raw <= 599) ? raw : 200;
    res.status(status).set(headers).json({ ...response, status, success: status < 400 });
  }

  makeUrl = (href, currentURL) => RouterUtils.buildUrl(href, currentURL);

  redirect(req, res, url) {
    if (res.headersSent) return;

    const redirectUrl = this.makeUrl(url, req._parsedUrl?.pathname || '/');
    res.redirect(redirectUrl || '/desk');
  }

  /**
   * @param {Object} err - Error object
   * @returns {string} HTML error template
   */
  errTemplate = (err) => RouterUtils.generateErrorTemplate(err);

  /**
   * @param {*} err - Error to throw
   * @param {Object} res - Express response object
   * @returns {string|undefined} Error string if no response sent
   */
  throw(err, res) {
    const error = getHttpError(err);
    const code = Number(error?.code) || 500;
    const errString = this.errTemplate(error);

    if (res && !res.headersSent) {
      res
        .status(code)
        .set('Content-Type', 'text/html')
        .send(errString);
      return;
    }

    return errString;
  }
}