'use strict';

/**
 * Tenant limits — caps a workspace carries in sites/<tenant>/config.json
 * (`limits: { users }`), set by whoever operates the server (Tenant Manager,
 * a billing app). No limit configured = unlimited.
 *
 * Users: desk users only (user_type "System") that are not disabled. Web
 * users (portal/site visitors) never count. Going over the limit never
 * disables anyone: it only stops new desk users until the count is back
 * under it.
 */

import { loopar } from '../loopar.js';
import { tenant } from '../../bin/tenant/tenant-builder.js';
import { requestContext } from '../server/router/request-context.js';

const truthy = (v) => [1, '1', true, 'true'].includes(v);
const isDeskUser = (row) => !!row && String(row.user_type || 'System') !== 'Web' && !truthy(row.disabled);

/** The user limit of a tenant, or null when it has none. */
export function userLimit(tenantName = loopar.tenantId) {
  const n = parseInt(tenant.readTenant(tenantName)?.limits?.users, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Active desk users of the current tenant. */
export async function deskUserCount({ except = null } = {}) {
  const rows = await loopar.db.getAll('User', ['name', 'user_type', 'disabled']);
  return rows.filter((row) => row.name !== except && isDeskUser(row)).length;
}

/**
 * Refuses a User save that would add an active desk user beyond the limit:
 * a new one, a disabled one being enabled, a web user becoming a desk user.
 */
export async function assertUserLimit(user) {
  const limit = userLimit();
  if (!limit || !isDeskUser({ user_type: user.user_type, disabled: user.disabled })) return;

  if (!user.__IS_NEW__) {
    const stored = await loopar.db.getRow('User', user.__DOCUMENT_NAME__ || user.name, ['user_type', 'disabled']);
    if (isDeskUser(stored)) return; // already counted: nothing is added
  }

  const used = await deskUserCount({ except: user.__IS_NEW__ ? null : user.name });
  if (used >= limit) {
    loopar.throw({
      code: 403,
      title: 'User limit reached',
      message: `This workspace includes ${limit} user${limit === 1 ? '' : 's'} and ${used} ${used === 1 ? 'is' : 'are'} active. Disable one or upgrade the plan to add more.`,
    });
  }
}

/**
 * Users of ANOTHER tenant, for whoever operates it (a control plane): its
 * limit and, when that tenant is loaded in this core, how many it uses
 * (`used` is null otherwise — a tenant is never booted just to count).
 */
export async function tenantUserUsage(tenantName, getInstance) {
  const limit = userLimit(tenantName);
  let used = null;
  try {
    if (getInstance?.(tenantName)) {
      used = await requestContext.run({ tenant: { name: tenantName } }, () => deskUserCount());
    }
  } catch (_) { used = null; }
  return { limit, used };
}
