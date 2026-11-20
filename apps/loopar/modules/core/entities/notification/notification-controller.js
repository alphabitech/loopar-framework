'use strict';

import { BaseController, loopar } from 'loopar';

const ENTITY = 'Notification';

/**
 * The signed-in user's notifications (desk bell). Every action reads and
 * writes the current user's rows only, so any signed-in user may call them.
 *   mine      → { unread, items } latest first (?limit, default 20)
 *   markRead  → { names: [...] } or { all: 1 }
 */
export default class NotificationController extends BaseController {
  static freeActions = ['mine', 'markRead'];

  #user() {
    const user = loopar.auth.user();
    if (!user) loopar.throw({ code: 401, message: 'Sign in to see your notifications.' });
    return user;
  }

  async actionMine() {
    const user = this.#user();
    const limit = Math.min(50, Math.max(1, Number(this.query?.limit ?? this.data?.limit) || 20));
    const q = () => loopar.db.qx()(ENTITY).where({ user });
    const items = await q().select('name', 'subject', 'message', 'document', 'document_name', 'from_user', 'is_read', 'created_at').orderBy('id', 'desc').limit(limit);
    const unread = Number((await q().where({ is_read: 0 }).count({ c: '*' }).first())?.c || 0);
    return { unread, items };
  }

  async actionMarkRead() {
    const user = this.#user();
    const all = [1, '1', true, 'true'].includes(this.data?.all ?? this.body?.all);
    let names = this.data?.names ?? this.body?.names;
    if (typeof names === 'string') names = loopar.utils.JSONparse(names, [names]);
    let qb = loopar.db.qx()(ENTITY).where({ user, is_read: 0 });
    if (!all) {
      if (!Array.isArray(names) || !names.length) return { updated: 0 };
      qb = qb.whereIn('name', names);
    }
    const updated = await qb.update({ is_read: 1 });
    return { updated };
  }
}
