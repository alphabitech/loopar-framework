'use strict';

import { loopar } from '../loopar.js';

/** Cookie holding the announcement a visitor closed (its name). */
export const ANNOUNCEMENT_DISMISSED_COOKIE = 'loopar_announcement_closed';

const today = () => new Date().toISOString().slice(0, 10);

/**
 * The announcement a website shows now: published, for this app, within its
 * dates, highest priority first (then the most recent start). Null when there
 * is none, the entity isn't installed, or the visitor closed it.
 */
export async function activeAnnouncement(app) {
  if (!app || !loopar.getRef('Announcement', false)) return null;
  const now = today();
  try {
    const row = await loopar.db.qx()('Announcement')
      .select(['name', 'headline', 'message', 'link_label', 'link_url', 'variant', 'dismissible'])
      .where({ app, published: 1 })
      .whereNull('__deleted_at__')
      .andWhere(q => q.whereNull('starts_on').orWhere('starts_on', '<=', now))
      .andWhere(q => q.whereNull('ends_on').orWhere('ends_on', '>=', now))
      .orderByRaw('coalesce(??, 0) desc', ['priority'])
      .orderBy('starts_on', 'desc')
      .first();
    if (!row) return null;
    const dismissible = [1, '1', true].includes(row.dismissible);
    if (dismissible && loopar.cookie?.get?.(ANNOUNCEMENT_DISMISSED_COOKIE) === row.name) return null;
    return { ...row, dismissible };
  } catch (err) {
    console.warn('[announcements] lookup failed:', err?.message || err);
    return null;
  }
}
