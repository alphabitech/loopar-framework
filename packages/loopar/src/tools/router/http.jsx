import { getWorkspaceName, workspaceRequiresAuth } from "@global/router-utils";
import { navTrace } from "./nav-trace.js";

export default class HTTP {
  #ui = {
    freeze: () => {},
    notify: () => {},
    refresh: () => {},
    error: (err) => { throw err; },
  };

  bindUI(adapter = {}) {
    this.#ui = { ...this.#ui, ...adapter };
  }

  /**
   * Navigation used for server-driven redirects. Default is a hard
   * navigation; Router overrides it with react-router awareness.
   */
  navigate(to) {
    if (typeof window !== 'undefined') window.location.assign(to);
  }

  /**
   * When an auth-protected action bounces us to /auth/login (e.g. an
   * authenticated surface's session expired mid-action), remember where we
   * were so login can return us there. Only augments login redirects coming
   * from an auth-required workspace (desk, portal, …) that don't already
   * carry a `redirect=` param. No-op for every other redirect.
   */
  #withReturnUrl(redirect) {
    if (typeof redirect !== 'string' || typeof window === 'undefined') return redirect;
    if (!/^\/auth\/login(\/|\?|$)/.test(redirect)) return redirect;
    if (/[?&]redirect=/.test(redirect)) return redirect;

    const here = window.location.pathname + window.location.search;
    if (!workspaceRequiresAuth(getWorkspaceName(window.location.pathname))) return redirect;

    return redirect + (redirect.includes('?') ? '&' : '?') + 'redirect=' + encodeURIComponent(here);
  }

  /** Self-contained cookie read — no dependency on any cookie helper. */
  #readCookie(name) {
    if (typeof document === 'undefined' || !document.cookie) return '';
    const match = document.cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
    return match ? decodeURIComponent(match[1]) : '';
  }

  /** CSRF double-submit token (cookie first, SSR-injected global second). */
  getCsrfToken() {
    const fromGlobal =
      typeof globalThis !== 'undefined' ? globalThis.__csrfToken__ : undefined;
    return this.#readCookie('csrf-token') || fromGlobal || '';
  }

  /**
   * Signed workspace identity issued by the server on the initial render
   * (`__META__.wsToken`). Proves which workspace this client is actually
   * browsing — the RPC channel carries no workspace in the URL.
   */
  getWorkspaceToken() {
    return (typeof globalThis !== 'undefined' && globalThis.__wsToken__) || '';
  }

  /**
   * Serializes `query` into a "?k=v&…" suffix. Accepts a plain object
   * (encoded here, null/undefined entries dropped) or a preformatted
   * string ("?a=1" / "a=1").
   */
  #buildQuery(query) {
    if (!query) return '';

    if (typeof query === 'string') {
      return query.startsWith('?') ? query : `?${query}`;
    }

    const entries = Object.entries(query)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);

    return entries.length ? `?${entries.join('&')}` : '';
  }

  /**
   * fetch() init for a request. Every request from this layer identifies
   * itself as an app request:
   *  - X-Requested-With marks the request as an app request (all RPC is
   *    POST today, but the header keeps non-POST transport unambiguous).
   *  - X-Workspace-Token is the signed browsing context (RPC URLs carry no
   *    workspace segment).
   *  - X-CSRF-Token is the double-submit CSRF check for mutations.
   */
  #buildFetchOptions({ method = 'POST', body }) {
    const csrf = this.getCsrfToken();
    const wsToken = this.getWorkspaceToken();

    const headers = {
      'X-Requested-With': 'XMLHttpRequest',
      ...(wsToken ? { 'X-Workspace-Token': wsToken } : {}),
      ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
    };

    const init = {
      method,
      mode: 'same-origin',
      cache: 'default',
      credentials: 'include',
      redirect: 'follow',
      referrerPolicy: 'no-referrer',
      headers,
    };

    if (body instanceof FormData) {
      // Browser sets the multipart boundary — don't touch Content-Type.
      init.body = body;
    } else if (body !== undefined && body !== null) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    } else if (!['GET', 'HEAD'].includes(String(method).toUpperCase())) {
      headers['Content-Type'] = 'application/json';
    }

    return init;
  }

  /**
   * Executes a request — the transport's single entry point (Router's
   * `call` and `fetchDocument` are built on top of it). Resolves with the
   * parsed controller response.
   *
   * @param {Object} options
   * @param {string} options.action - Literal URL (relative or absolute).
   * @param {string} [options.method="POST"]
   * @param {Object|FormData} [options.body]
   * @param {Object|string} [options.query]
   * @param {Function} [options.success]
   * @param {Function} [options.error]
   * @param {Function} [options.always]
   * @param {boolean}  [options.freeze=true]
   * @param {boolean}  [options.followRedirect=true] - Pass `false` to keep a
   *   server `redirect` payload OUT of the router: no navigation happens and
   *   `success` receives the full response (redirect included) so the caller
   *   can act on it. Used by saves inside a modal mini-workspace, where the
   *   global navigate would move the BASE page, not the modal.
   * @param {boolean}  [options.notifyError=true] - Pass `false` when the
   *   caller renders the error itself (e.g. the navigation fetch shows the
   *   error view) to avoid a duplicate toast.
   */
  async send(options = {}) {
    const freeze = options.freeze !== false;

    const url = `${options.action || ''}${this.#buildQuery(options.query)}`;
    const fetchOptions = this.#buildFetchOptions(options);

    const withFreeze = async (promise, delay = 200) => {
      if (!freeze) return promise;

      let freezeTimeout;
      const startFreeze = new Promise(resolve => {
        freezeTimeout = setTimeout(() => {
          this.#ui.freeze(true);
          resolve();
        }, delay);
      });

      try {
        return await Promise.race([startFreeze, promise]).then(() => promise);
      } finally {
        clearTimeout(freezeTimeout);
        this.#ui.freeze(false);
      }
    };

    try {
      const fetchPromise = fetch(url, fetchOptions)
        .then(async response => {
          // fetch() follows 3xx silently. The server never redirects the AJAX
          // channel on purpose (redirects travel inside the JSON); if one was
          // followed anyway, the body belongs to ANOTHER url and rendering it
          // would show that page under the current URL. Make it a real
          // navigation to where the server sent us instead.
          if (response.redirected && typeof window !== 'undefined') {
            const finalUrl = new URL(response.url, window.location.origin);
            const dest = this.#withReturnUrl(finalUrl.pathname + finalUrl.search);
            navTrace('followed-302', { request: url, to: dest });
            window.location.replace(dest);
            return new Promise(() => {}); // page is unloading — never settle
          }

          const isJson = response.headers.get('content-type')?.includes('application/json');
          const data = isJson ? await response.json() : null;

          if (!response.ok || (response.status && response.status !== 200)) {
            throw (data || {
              status: response.status,
              code: response.status,
              title: response.statusText || 'Request Error',
              message: response.statusText || `Request failed with status ${response.status}`
            });
          }

          if (data?.redirect && options.followRedirect !== false) {
            navTrace('redirect', { request: url, to: data.redirect, hard: !!data.hardRedirect });
            if (data.hardRedirect) {
              window.location.replace(data.redirect);
            } else {
              this.navigate(data.redirect, { replace: true });
            }
            if (options.success) options.success?.(data?.message || data);
            return data;
          }

          if (options.success) {
            // followRedirect:false callers need the whole payload (redirect,
            // name, …), not the message shorthand.
            options.success?.(options.followRedirect === false ? data : (data?.message || data));
          }

          data?.notify && this.#ui.notify(data.notify);

          if (data?.refresh) {
            navTrace('refresh', { request: url, mode: data.refresh });
            if (data.refresh === 'hard') {
              window.location.reload();
            } else {
              this.#ui.refresh();
            }
          }

          return data;
        });

      return await withFreeze(fetchPromise);
    } catch (error) {
      if (error?.redirect) {
        const dest = this.#withReturnUrl(error.redirect);
        navTrace('error-redirect', { request: url, to: dest, hard: !!error.hardRedirect, code: error.code, message: error.message });
        if (error.hardRedirect) {
          window.location.replace(dest);
        } else {
          this.navigate(dest, { replace: true });
        }
        return;
      }

      if (options.error) {
        if (options.notifyError !== false) {
          this.#ui.notify(error.notify || {
            title: error.title,
            message: error.message,
            type: "error"
          });
        }
        options.error(error);
      } else {
        this.#ui.error({
          code: error.code,
          title: error.title || 'Error',
          message: error.message || 'An unexpected error occurred',
        });
      }
    } finally {
      options.always?.();
    }
  }
}
