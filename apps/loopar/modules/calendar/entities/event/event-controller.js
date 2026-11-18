'use strict';

import { BaseController, loopar } from 'loopar';
import { PermissionManager } from 'loopar/core/auth/PermissionManager.js';
import { CALENDAR, EVENT, calendarLayers, toDateTime } from '../../calendar.js';

const PREFILL = ['title', 'starts_at', 'ends_at', 'all_day', 'calendar', 'location', 'document', 'document_name'];
const MAX_RELATED = 100;

export default class EventController extends BaseController {
  constructor(props) {
    super(props);
  }

  /**
   * `Event/create?starts_at=…&document=…&document_name=…` opens the form
   * already filled: the calendar passes the slot the user picked, a record's
   * "Schedule" action passes the record.
   */
  async actionCreate() {
    const query = this.query || {};
    const prefill = Object.fromEntries(PREFILL.filter((f) => String(query[f] ?? '').trim() !== '').map((f) => [f, String(query[f]).trim()]));
    if (this.hasData() || !Object.keys(prefill).length) return await super.actionCreate();

    for (const f of ['starts_at', 'ends_at']) if (prefill[f]) prefill[f] = toDateTime(prefill[f]) || undefined;
    if (prefill.document && !loopar.getRef(prefill.document, false)) { delete prefill.document; delete prefill.document_name; }

    const document = await loopar.newDocument(this.document, prefill);
    if (this.preloaded == true) return await document.values();

    Object.assign(this.response, await document.__meta__());
    return await this.render(this.response);
  }

  /**
   * What the calendar draws for this user: the layers (entities with date
   * fields they may list) and the calendars with their color:
   * `Event/layers`. Data endpoint: no `message` key.
   */
  async actionLayers() {
    const calendars = await loopar.db.query(CALENDAR)
      .whereNull('__deleted_at__')
      .orderBy('name', 'asc')
      .select('name', 'color', 'disabled');

    return {
      layers: calendarLayers(),
      calendars: calendars.map((c) => ({ name: c.name, color: c.color || 'blue', disabled: [1, '1', true].includes(c.disabled) })),
    };
  }

  /**
   * Events related to one record, soonest first: `Event/of?document=X&document_name=Y`
   * (the "Events" panel of that record's form). Needs to see the record's entity.
   */
  async actionOf() {
    const document = String(this.query?.document ?? '').trim();
    const documentName = String(this.query?.document_name ?? '').trim();
    const ref = document && loopar.getRef(document, false);
    if (!ref || !documentName) loopar.throw({ code: 400, message: 'document and document_name are required.' });
    if (!PermissionManager.can(ref.__NAME__, 'view', loopar.auth?.user?.())) {
      loopar.throw({ code: 403, message: `You can't see ${ref.__NAME__} records.` });
    }

    const rows = await loopar.db.query(EVENT)
      .where({ document: ref.__NAME__, document_name: documentName })
      .whereNull('__deleted_at__')
      .orderBy([{ column: 'starts_at', order: 'asc' }, { column: 'id', order: 'asc' }])
      .limit(MAX_RELATED)
      .select('name', 'title', 'starts_at', 'ends_at', 'all_day', 'calendar', 'location');

    return {
      events: rows.map((row) => ({
        name: row.name,
        title: row.title || row.name,
        starts_at: toDateTime(row.starts_at),
        ends_at: toDateTime(row.ends_at),
        all_day: [1, '1', true].includes(row.all_day),
        calendar: row.calendar || '',
        location: row.location || '',
      })),
    };
  }
}
