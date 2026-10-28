'use strict';

import { getRequest } from '../server/router/request-context.js';

/**
 * List state (filters + page) lives in the URL of the request, never in the
 * session: `/desk/Customer/list?status=Open&city=Boston&page=2` is the whole
 * state, so a list can be shared, bookmarked or reloaded as-is.
 *
 * Every query parameter that is not a control parameter is a filter candidate
 * (`BaseDocument.buildCondition` keeps only real fields of the entity). Values
 * are read from the raw query string so "00123" stays a string.
 *
 * Like the owner scope (auth/record-scope.js), the state applies only to the
 * entity the request targets: any other list read inside the same request
 * (a history table, a card of a desk page…) starts clean on page 1.
 */
export const LIST_CONTROL_PARAMS = new Set(['page', 'preloaded', 'board', 'workspace']);

function targetQuery(entityName) {
  const req = getRequest();
  const controller = req?.__CONTROLLER__;
  if (!controller || controller.document !== entityName) return null;
  return req.query || {};
}

const lastString = (value) => {
  const v = Array.isArray(value) ? value[value.length - 1] : value;
  if (typeof v === 'string') return v;
  return typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';
};

/** Filters of the current request for `entityName`: `{ field: "value" }`, empty values dropped. */
export function listFilters(entityName, { exclude = [] } = {}) {
  const query = targetQuery(entityName);
  if (!query) return {};

  const skip = new Set([...LIST_CONTROL_PARAMS, ...exclude]);
  const filters = {};
  for (const [key, value] of Object.entries(query)) {
    if (skip.has(key)) continue;
    const v = lastString(value).trim();
    if (v !== '') filters[key] = v;
  }
  return filters;
}

/** Page of the current request for `entityName` (1-based, defaults to 1). */
export function listPage(entityName) {
  const query = targetQuery(entityName);
  const page = parseInt(lastString(query?.page), 10);
  return Number.isFinite(page) && page > 0 ? page : 1;
}

/** Page clamped to the available pages (an out-of-range URL shows the last page). */
export function clampPage(page, totalPages) {
  return Math.min(Math.max(1, page || 1), Math.max(1, totalPages || 1));
}
