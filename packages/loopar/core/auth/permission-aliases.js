'use strict';

/**
 * Actions authorized with the grant of another action (keys in lower case):
 *
 *   changeProtected   changing a protected field of a record needs `update`
 *                     on it (plus a fresh re-authentication, checked by the
 *                     action itself).
 *   board, calendar,  the data of a list view is the list seen another way:
 *   report            whoever may `list` an entity may read them, narrowed
 *                     to the same records ('own' / 'customer' scope).
 *   bulkUpdate,       a bulk action is its single action on each selected
 *   bulkTransition    record: the same grant, the same scope per record.
 *
 * An aliased action is never granted on its own, so it is not offered in the
 * permission manager.
 */
export const PERMISSION_ALIASES = Object.freeze({
  changeprotected: 'update',
  board: 'list',
  calendar: 'list',
  report: 'list',
  bulkupdate: 'update',
  bulktransition: 'transition',
});

/** The action whose grant authorizes `action`. */
export const permissionActionOf = (action) => PERMISSION_ALIASES[String(action ?? '').toLowerCase()] || action;
