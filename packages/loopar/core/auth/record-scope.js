'use strict';

import { getRequest } from '../server/router/request-context.js';

/**
 * Owner filter for a list of `entityName`, bound to the CURRENT REQUEST.
 *
 * Returns the request controller's `ownerFilters()` only when the entity being
 * listed IS the document the request targets and the request's grant has a
 * narrowing scope ('own' or 'customer'). Any other read — a different entity loaded inside an action,
 * a job, an installer, a hook — gets null and is never narrowed. This is what
 * makes it safe to apply at model level (BaseDocument.getList): a controller
 * overriding `actionList` still goes through the filter, but Invoice.update
 * reading Materials does not.
 *
 * `loopar.getList(doc, { unscoped: true })` is the explicit escape hatch.
 */
export async function requestOwnerFilter(entityName) {
  const controller = getRequest()?.__CONTROLLER__;
  if (!controller || typeof controller.ownerFilters !== 'function') return null;
  if (controller.document !== entityName) return null;
  return await controller.ownerFilters();
}
