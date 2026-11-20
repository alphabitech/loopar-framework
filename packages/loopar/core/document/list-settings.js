'use strict';

import { loopar } from '../loopar.js';
import { getRequest } from '../server/router/request-context.js';
import { LIST_SETTING_ENTITY, listSettingName, normalizeListSettings } from '../global/list-settings.js';

/**
 * Per-user list settings (global/list-settings.js), one `List View Setting`
 * record per user and entity. A tenant whose app doesn't have the entity yet
 * simply has no settings.
 */
const installed = () => !!loopar.getRef(LIST_SETTING_ENTITY);
const table = () => loopar.db.qx()(LIST_SETTING_ENTITY);

/** The user's settings for the list of `entity` (defaults when none saved); null when there is no user or no storage. */
/**
 * Portal lists show the entity's own columns: customers don't pick columns
 * (a field the entity doesn't list is not theirs to see). True for a request
 * in the portal workspace and for any Web user.
 */
function portalList() {
  if (getRequest()?.__WORKSPACE_NAME__ === 'portal') return true;
  try {
    return loopar.auth?.authUser?.()?.user_type === 'Web';
  } catch {
    return false;
  }
}

export async function readListSettings(entity, user = loopar.auth?.user?.()) {
  if (!user || user === 'Guest' || !installed() || portalList()) return null;
  try {
    const row = await table().select('settings_json').where({ name: listSettingName(user, entity) }).whereNull('__deleted_at__').first();
    return normalizeListSettings(row?.settings_json);
  } catch (e) {
    console.warn(`[list] settings of ${entity} could not be read:`, e?.message || e);
    return null;
  }
}

/** Saves (replaces) the user's settings for the list of `entity`; returns them normalized. */
export async function writeListSettings(entity, settings, user = loopar.auth?.user?.()) {
  if (!user || user === 'Guest') loopar.throw({ code: 401, message: 'You must be logged in to save list settings.' });
  if (!installed()) loopar.throw({ code: 404, message: 'List settings are not available: update the loopar app.' });

  const normalized = normalizeListSettings(settings);
  const name = listSettingName(user, entity);
  const values = { settings_json: JSON.stringify(normalized), __deleted_at__: null };

  const row = await table().select('id').where({ name }).first();
  if (row) await table().where({ id: row.id }).update(values);
  else await table().insert({ name, owner_user: user, target_entity: entity, ...values });

  return normalized;
}
