'use strict';

export const ASSET_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'svg', 'webp', 'ico', // Images
  'mp4', 'webm', 'ogg', 'mp3', 'wav', 'flac', 'aac', // Multimedia
  'woff', 'woff2', 'ttf', 'eot', 'otf', // Fonts
  'js', 'mjs', 'jsx', 'css', 'html', 'htm', 'xhtml', // Web files
  'zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'gzip', 'br', // Compressed
  'json', 'xml', 'txt', 'yaml', // Data
]);

export const VALID_WORKSPACES = ['desk', 'auth', 'loopar', 'api', 'portal'];

export const WORKSPACE_CAPABILITIES = {
  web: { public: true, requiresAuth: false, enforceCsrf: false, blockWebUsers: false, isAuth: false, urlPrefixed: false },
  loopar: { public: true, requiresAuth: false, enforceCsrf: false, blockWebUsers: false, isAuth: false, urlPrefixed: true  },
  auth: { public: false, requiresAuth: false, enforceCsrf: false, blockWebUsers: false, isAuth: true, urlPrefixed: false },
  desk: { public: false, requiresAuth: true, enforceCsrf: true, blockWebUsers: true, isAuth: false, urlPrefixed: true  },
  api: { public: false, requiresAuth: true, enforceCsrf: true, blockWebUsers: false, isAuth: false, urlPrefixed: true  },
  portal: { public: false, requiresAuth: true, enforceCsrf: true, blockWebUsers: false, isAuth: false, urlPrefixed: true  },
};

/** Capabilities for a workspace name. Unknown names fall back to `web` (matches getWorkspaceName). */
export function workspaceCapabilities(name) {
  return WORKSPACE_CAPABILITIES[name] || WORKSPACE_CAPABILITIES.web;
}

/** True when the workspace requires a logged-in user. */
export function workspaceRequiresAuth(name) {
  return !!workspaceCapabilities(name).requiresAuth;
}

/**
 * True when a NAVIGATION url for this workspace starts with the workspace
 * segment (`/desk/...`), i.e. the segment must be dropped before the path
 * is read as `{document}/{action}`. Callers ask this instead of testing
 */
export function workspaceIsUrlPrefixed(name) {
  return !!workspaceCapabilities(name).urlPrefixed;
}

export const SYSTEM_PATHS = {
  CONNECT: '/loopar/system/connect',
  UPDATE: '/loopar/system/update',
  INSTALL: '/loopar/system/install',
};

export function generateErrorTemplate(err) {
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const status = Number(err.status ?? err.code) || 500;
  const kind = status >= 500 ? '5xx' : status >= 400 ? '4xx' : 'info';
  const scope = status >= 500 ? 'SERVER' : status >= 400 ? 'CLIENT' : 'INFO';
  const reason = err.frame ? 'PARSE ERROR'
    : status === 404 ? 'NOT FOUND'
    : status === 403 ? 'FORBIDDEN'
    : status === 401 ? 'UNAUTHORIZED'
    : 'ERROR';
  const pathMatch = String(err.message || '').match(/([^\s()]+:\d+:\d+)/);
  const framePath = pathMatch ? pathMatch[1] : 'source';

  const frameBlock = err.frame ? `
      <div class="le-frame">
        <div class="le-hdr">
          <span class="le-path">${esc(framePath)}</span>
          <button class="le-copy" type="button" onclick="(function(b){try{navigator.clipboard.writeText(document.getElementById('le-frame').textContent);var t=b.textContent;b.textContent='Copied';setTimeout(function(){b.textContent=t;},1200);}catch(e){}})(this)">Copy</button>
        </div>
        <pre id="le-frame">${esc(err.frame)}</pre>
      </div>` : '';

  const homeLink = kind === '4xx' ? `<a class="le-home" href="/">← Back to home</a>` : '';

  return `<style>
    html,body{height:100%;margin:0}
    .loopar-error{min-height:100%;box-sizing:border-box;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:32px;background:#0b0b0f;color:#c7c7da;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;overflow:auto}
    .loopar-error *{box-sizing:border-box}
    .le-wrap{width:100%;max-width:760px;text-align:center}
    .le-chip{display:inline-flex;align-items:center;gap:8px;font:600 12px ui-monospace,monospace;letter-spacing:.04em;padding:5px 12px;border-radius:999px;margin-bottom:8px}
    .le-chip .le-dot{width:7px;height:7px;border-radius:50%}
    .le-code{font-weight:800;font-size:92px;line-height:1;margin:6px 0 2px}
    .le-title{font-size:26px;font-weight:700;margin:12px 0 6px;color:#f1f1f8}
    .le-msg{font-size:15.5px;color:#a9a9c0;margin:0 auto 4px;max-width:90%;line-height:1.5}
    .le-frame{text-align:left;margin:26px auto 8px;width:100%;border:1px solid rgba(240,120,120,.28);border-radius:12px;background:rgba(255,255,255,.025);overflow:hidden}
    .le-hdr{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 14px;border-bottom:1px solid rgba(240,120,120,.18);background:rgba(240,120,120,.05)}
    .le-path{font:12px ui-monospace,monospace;color:#d69b9b;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .le-copy{font:600 11px ui-sans-serif,system-ui;color:#e5a0a0;background:transparent;border:1px solid rgba(240,120,120,.4);border-radius:7px;padding:4px 10px;cursor:pointer;flex:none}
    .le-frame pre{margin:0;padding:16px;overflow:auto;max-height:46vh;font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;color:#e2a6a6;white-space:pre}
    .le-foot{margin-top:30px;display:flex;flex-direction:column;align-items:center;gap:14px}
    .le-foot hr{width:180px;border:none;border-top:1px solid #2a2a3e;margin:0}
    .le-brand{font:700 15px ui-sans-serif,system-ui;letter-spacing:.06em;background:linear-gradient(90deg,#ff6b6b,#bd34fe,#41d1ff);-webkit-background-clip:text;background-clip:text;color:transparent}
    .le-home{font:500 13px ui-sans-serif,system-ui;color:#7e7e9c;text-decoration:none}
    .le-home:hover{color:#aab}
    .loopar-error[data-kind="5xx"] .le-chip{background:rgba(240,80,80,.10);color:#f0a3a3}
    .loopar-error[data-kind="5xx"] .le-chip .le-dot{background:#f0605f}
    .loopar-error[data-kind="5xx"] .le-code{color:#f0a3a3;text-shadow:0 0 40px rgba(240,80,80,.25)}
    .loopar-error[data-kind="4xx"] .le-chip{background:rgba(224,193,100,.12);color:#e0c164}
    .loopar-error[data-kind="4xx"] .le-chip .le-dot{background:#e0c164}
    .loopar-error[data-kind="4xx"] .le-code{color:#d9c07f;text-shadow:0 0 40px rgba(224,193,100,.18)}
    .loopar-error[data-kind="info"] .le-chip{background:rgba(120,140,220,.12);color:#9ab0e6}
    .loopar-error[data-kind="info"] .le-chip .le-dot{background:#6d84d8}
  </style>
  <div class="loopar-error" data-kind="${kind}">
    <div class="le-wrap">
      <span class="le-chip"><span class="le-dot"></span>${esc(scope)} · ${esc(reason)}</span>
      <div class="le-code">${esc(status)}</div>
      <h1 class="le-title">${esc(err.title)}</h1>
      <p class="le-msg">${esc(err.message)}</p>
      ${frameBlock}
      <div class="le-foot">
        <hr>
        <span class="le-brand">LOOPAR</span>
        ${homeLink}
      </div>
    </div>
  </div>`;
}

/**
 * Returns true when the URL points to a static asset (image, font, css,
 * etc.) that should bypass the controller pipeline. Routes under /api/
 * and /admin/ are explicitly excluded so dynamic endpoints whose URL
 * happens to end in a known extension still get routed.
 */
export function isAssetUrl(pathname) {
  if (pathname.includes('/api/') || pathname.includes('/admin/')) return false;

  const lastDotIndex = pathname.lastIndexOf('.');
  if (lastDotIndex === -1) return false;

  const extension = pathname.substring(lastDotIndex + 1).toLowerCase();
  return ASSET_EXTENSIONS.has(extension);
}

export function getWorkspaceName(pathname) {
  const context = pathname.split('/')[1] || 'web';
  return VALID_WORKSPACES.includes(context.toLowerCase())
    ? context.toLowerCase()
    : 'web';
}

export function setDefaultParams(params, workspaceName) {
  if (workspaceName === 'portal') {
    if (!params.document) {
      params.document = 'Profile';
      params.action = 'update';
    }
    params.action ??= 'view';
    return params;
  }

  if (!params.document && !params.action && workspaceName === 'desk') {
    params.document = 'Desk';
    params.action = 'view';
  }

  const defaultDocument = {
    desk: 'Module',
    auth: 'Auth',
  };

  const defaultAction = {
    desk: 'view',
    auth: 'login',
    web: 'view',
  };

  if (!params.action || !params.document) {
    params.name = params.document;
    params.document = defaultDocument[workspaceName];
    params.action ??= defaultAction[workspaceName];
  }

  return params;
}

/**
 * A `?redirect=` value we may send the user back to: a same-origin absolute
 * path, never an auth / system-setup / API url (those would loop or make no
 * sense as a landing page). Returns null when unsafe.
 */
export function safeReturnPath(url) {
  if (typeof url !== 'string' || !url) return null;
  if (!url.startsWith('/') || url.startsWith('//') || url.includes('\\')) return null;
  const lower = url.toLowerCase();
  if (/^\/(auth|loopar|api)(\/|\?|$)/.test(lower)) return null;
  return url;
}

export function buildUrl(href, currentURL) {
  if (!href || href.startsWith('http') || href.startsWith('/')) return href;

  const [cleanCurrentURL] = (currentURL ?? '').split('?');
  const urlArray = cleanCurrentURL.split('/');

  const urlStructure = ['workspace', 'document', 'action'];
  const urlObject = urlStructure.reduce((obj, key, index) => {
    obj[key] = urlArray[index + 1];
    return obj;
  }, {});

  const [baseUrl, queryString] = href.split('?');
  const baseUrlSegments = baseUrl.split('/').reverse();

  for (let i = 0; i < urlStructure.length; i++) {
    const key = urlStructure[urlStructure.length - 1 - i];
    urlObject[key] = baseUrlSegments[i] || urlObject[key];
  }

  const pathParts = Object.values(urlObject).filter((e) => e && e !== '');
  return `/${pathParts.join('/')}${queryString ? '?' + queryString : ''}`;
}

export const RouteParsing = {
  /**
   * Parses an RPC/API route: `/{Document}/{action}` (an optional leading
   * `api` segment is stripped). RPC routes carry NO workspace prefix — the
   * request's workspace context travels in the signed `X-Workspace-Token`
   * header instead, and the Document segment is always explicit.
   */
  parseRpcParams(pathname) {
    const clean = (pathname ?? '').split('?')[0];
    const segments = clean.split('/').filter((s) => s && s.length > 0);

    if (segments[0]?.toLowerCase() === 'api') segments.shift();

    return {
      host: null,
      document: segments[0] ? decodeURIComponent(segments[0]) : null,
      action: segments[1] ? decodeURIComponent(segments[1]) : null,
    };
  },

  /**
   * Splits a pathname into the canonical `{ host, document, action }`
   * shape. Whether the first segment is a workspace prefix to drop is
   * declared per workspace (`urlPrefixed` in WORKSPACE_CAPABILITIES),
   * not hardcoded here.
   */
  parseParams(pathname, workspaceName) {
    const cleanPathname = (pathname ?? '').split('?')[0];
    const routeStructure = { host: null, document: null, action: null };

    const adjustedPathname = workspaceIsUrlPrefixed(workspaceName)
      ? cleanPathname.split('/').slice(1).join('/')
      : cleanPathname;

    const segments = adjustedPathname.split('/');
    const keys = Object.keys(routeStructure);

    for (let i = 0; i < segments.length && i < keys.length; i++) {
      const seg = segments[i];
      if (seg && seg.length > 0) {
        routeStructure[keys[i]] = decodeURIComponent(seg);
      }
    }

    return routeStructure;
  },

  findWebAppMenu(document, loopar) {
    const webApp = loopar.webApp || { menu_items: [] };
    return webApp.menu_items?.find(
      (item) => loopar.utils.toEntityKey(item.link) === loopar.utils.toEntityKey(document)
    );
  },
};

export const RouterUtils = {
  ASSET_EXTENSIONS,
  VALID_WORKSPACES,
  WORKSPACE_CAPABILITIES,
  SYSTEM_PATHS,

  generateErrorTemplate,
  isAssetUrl,
  getWorkspaceName,
  workspaceCapabilities,
  workspaceRequiresAuth,
  workspaceIsUrlPrefixed,
  setDefaultParams,
  buildUrl,

  RouteParsing,
};
