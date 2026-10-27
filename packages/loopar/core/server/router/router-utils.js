'use strict';

import {
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
  workspaceServesWebPages,
  setDefaultParams,
  buildUrl,
  RouteParsing,
} from '../../global/router-utils.js';

export {
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
  workspaceServesWebPages,
  setDefaultParams,
  buildUrl,
  RouteParsing,
};

export function isAjaxRequest(req) {
  if (typeof req.__IS_AJAX__ === 'boolean') return req.__IS_AJAX__;
  return (
    req.method === 'POST' ||
    req.__WORKSPACE_NAME__ === 'api' ||
    getWorkspaceName(req._parsedUrl?.pathname || req.path || '') === 'api' ||
    String(req.headers?.['x-requested-with'] || '').toLowerCase() === 'xmlhttprequest'
  );
}

/**
 * Resolves HOW a request should be routed. Two modes:
 *
 *  - `navigation`: a real navigation — render (or return the meta of) what
 *    was navigated to. The workspace is trustworthy here: on a full GET it
 *    IS the URL prefix; on the SPA's document fetch (a POST) it arrives as
 *    the explicit `workspace` query param sent by the workspace provider.
 *    Parsing uses the classic workspace conventions (defaults, web menu…).
 *
 * @returns {{ mode: 'navigation'|'rpc', workspace: string }}
 */
export function resolveRequestRoute(req, verifyWorkspaceToken) {
  const pathname = req._parsedUrl?.pathname || req.path || '';
  const urlWorkspace = getWorkspaceName(pathname);

  const ajax =
    req.method === 'POST' ||
    urlWorkspace === 'api' ||
    String(req.headers?.['x-requested-with'] || '').toLowerCase() === 'xmlhttprequest';

  // Full page load / asset-like GET: the URL is the workspace.
  if (!ajax) return { mode: 'navigation', workspace: urlWorkspace };

  // Third-party API surface keeps its explicit prefix.
  if (urlWorkspace === 'api') return { mode: 'rpc', workspace: 'api' };

  // SPA navigation fetch: the ONLY ajax channel that names a workspace,
  // and it does so as a parameter (this is a render request, not an RPC).
  const navWorkspace = req.query?.workspace;
  if (typeof navWorkspace === 'string' && navWorkspace.length) {
    const name = navWorkspace.toLowerCase();
    const valid = VALID_WORKSPACES.includes(name) || name === 'web';
    return { mode: 'navigation', workspace: valid ? name : 'web' };
  }

  // Bare RPC: workspace context from the signed token.
  const signed = verifyWorkspaceToken
    ? verifyWorkspaceToken(req.headers?.['x-workspace-token'])
    : null;
  if (signed) return { mode: 'rpc', workspace: signed };

  // Legacy ajax without token (raw fetch to /auth/me, /auth/oauthProviders…).
  return { mode: 'rpc', workspace: urlWorkspace };
}

export function isMultipartFormData(contentType) {
  return contentType?.startsWith('multipart/form-data');
}

export function prepareFileData(body, files) {
  return {
    ...body,
    ...(files?.length > 0 ? { __REQ_FILES__: files } : {}),
  };
}


function parseQueryValue(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (value === 'undefined') return undefined;
  if (value !== '' && !isNaN(Number(value))) return Number(value);
  return value;
}

export function parseQuery(query = {}) {
  return Object.fromEntries(
    Object.entries(query).map(([k, v]) => [k, parseQueryValue(v)])
  );
}

export const SystemValidation = {
  getStatus(loopar) {
    const { DBServerInitialized, DBInitialized, __installed__, __wasInstalled__ } = loopar;

    return {
      needsConnect: !DBServerInitialized,
      needsInstallOrUpdate: DBServerInitialized && (!DBInitialized || !__installed__),
      needsUpdate: !!DBInitialized && !!__wasInstalled__,
      isFullyInstalled: DBServerInitialized && DBInitialized && __installed__,
      connectPath: SYSTEM_PATHS.CONNECT,
      updatePath: SYSTEM_PATHS.UPDATE,
      installPath: SYSTEM_PATHS.INSTALL,
    };
  },

  getRedirectPath(loopar) {
    const status = this.getStatus(loopar);

    if (status.needsConnect) return status.connectPath;
    if (status.needsInstallOrUpdate) {
      return status.needsUpdate ? status.updatePath : status.installPath;
    }

    return null;
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
  workspaceServesWebPages,
  isMultipartFormData,
  prepareFileData,
  setDefaultParams,
  buildUrl,
  isAjaxRequest,
  resolveRequestRoute,

  RouteParsing,
  SystemValidation,
  parseQuery,
};
