'use strict';

import {
  PageController, PermissionManager, loopar, tenantRegistry, getTenantInstance, requestContext,
  clientIp, ipHash, operatorIpHashes, isControlPlaneTenant,
} from 'loopar';

const ENTITY = 'Page View';
const CHUNK = 500;

/** Can the current user act as platform operator (from a control plane)? */
export function isOperator(user = loopar.auth?.user?.()) {
  if (!user || user === 'Guest' || !isControlPlaneTenant()) return false;
  return user === 'Administrator' || PermissionManager.can('Tenant Manager', 'view', user);
}

const num = (row) => +(row?.n ?? 0) || 0;
const notFlagged = function () { this.whereNot('is_internal', 1).orWhereNull('is_internal'); };

/**
 * Own-traffic cleanup over the ACTIVE tenant's Page View table. Deletes:
 *  - rows flagged is_internal=1 (logged-in views; already hidden), and
 *  - anonymous rows sharing an ip_hash with any of those, with `extraHashes`
 *    (the caller's connection) or with an operator connection.
 */
async function purgeCurrentTenant(extraHashes, dryRun) {
  const flaggedRows = await loopar.db.query(ENTITY).distinct('ip_hash').where('is_internal', 1).whereNotNull('ip_hash');
  const list = [...new Set([
    ...flaggedRows.map(r => r.ip_hash),
    ...extraHashes,
    ...operatorIpHashes(),
  ].filter(Boolean))];

  const flagged = num(await loopar.db.query(ENTITY).where('is_internal', 1).count('* as n').first());
  let anonymous = 0;
  for (let i = 0; i < list.length; i += CHUNK) {
    anonymous += num(await loopar.db.query(ENTITY)
      .whereIn('ip_hash', list.slice(i, i + CHUNK)).andWhere(notFlagged)
      .count('* as n').first());
  }

  const result = { flagged, anonymous, total: flagged + anonymous };
  if (dryRun || !result.total) return result;

  let deleted = await loopar.db.query(ENTITY).where('is_internal', 1).delete();
  for (let i = 0; i < list.length; i += CHUNK) {
    deleted += await loopar.db.query(ENTITY).whereIn('ip_hash', list.slice(i, i + CHUNK)).delete();
  }
  return { ...result, deleted };
}

export default class AnalyticsDashboardController extends PageController {
  constructor(props) {
    super(props);
  }

  async actionView(){
    const view = await loopar.newDocument("Analytics Dashboard")
    // loopar.call sends these as query params (this.query), not in the body.
    const input = { ...(this.data || {}), ...(this.query || {}) };
    const days = Math.max(1, Math.min(365, Number(input.days) || 30));
    view.days = days;
    view.site = String(input.site || '');

    if(this.method == AJAX && this.preloaded=='true'){
      return {
        instance: this.getInstance(),
        data: await view.data()
      }
    }

    return this.render(view)
  }

  /**
   * Retroactive cleanup of own traffic recorded before internal networks
   * existed. Idempotent; safe to re-run.
   * Body: { dry_run: 1 } → only counts.
   *       { all_tenants: 1 } → operator on a control plane: every ONLINE
   *       tenant of this core (offline ones are listed as skipped).
   */
  async actionPurgeInternal() {
    const input = { ...(this.query || {}), ...(this.data || {}) };
    const dryRun = String(input.dry_run || '') === '1';
    const allTenants = String(input.all_tenants || '') === '1';
    const own = [ipHash(clientIp(this.req || {}))];

    if (!allTenants) {
      if (!PermissionManager.can(ENTITY, 'delete')) {
        loopar.throw({ status: 403, title: 'Forbidden', message: 'Not permitted' });
      }
      const r = await purgeCurrentTenant(own, dryRun);
      return { purge: { ...r, dry_run: dryRun } };
    }

    if (!isOperator()) {
      loopar.throw({ status: 403, title: 'Forbidden', message: 'Only the platform operator can clean every tenant' });
    }

    const tenants = [];
    const skipped = [];
    for (const { name } of tenantRegistry.all()) {
      if (!getTenantInstance(name)) { skipped.push(name); continue; }
      try {
        const r = await requestContext.run({ tenant: { name } }, () => purgeCurrentTenant(own, dryRun));
        if (r.total) tenants.push({ name, ...r });
      } catch (error) {
        // Tenant without analytics (or DB down): report, don't abort the rest.
        skipped.push(name);
        console.warn(['[analytics] purge skipped', name, error?.message]);
      }
    }

    const sum = (k) => tenants.reduce((a, t) => a + (t[k] || 0), 0);
    return {
      purge: {
        tenants, skipped,
        flagged: sum('flagged'), anonymous: sum('anonymous'), total: sum('total'),
        deleted: dryRun ? undefined : sum('deleted'),
        dry_run: dryRun, all_tenants: true,
      },
    };
  }
}
