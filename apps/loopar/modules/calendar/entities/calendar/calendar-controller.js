'use strict';

import crypto from 'node:crypto';
import { BaseController, loopar, getRequest } from 'loopar';
import { CALENDAR, EVENT, toDateTime, addMinutes, scheduleEvent } from '../../calendar.js';
import { addDays, isDay } from 'loopar/core/global/calendar.js';
import { buildICal } from '../../ical.js';
import { bookingConfig, busyRanges, freeSlots, minutesOf } from '../../booking.js';
import { verifyCaptcha } from 'loopar/core/document/web-form.js';

const MAX_EVENTS = 2000;
// Events older than this are left out of the feed (recurring ones always go).
const PAST_DAYS = 180;

const newToken = () => crypto.randomBytes(24).toString('hex');

/** Origin of the current request (proxy headers first), e.g. https://example.com. */
function origin() {
  const req = getRequest();
  const proto = String(req?.headers?.['x-forwarded-proto'] || req?.protocol || 'http').split(',')[0].trim();
  const host = String(req?.headers?.['x-forwarded-host'] || req?.headers?.host || process.env.DOMAIN || 'localhost').split(',')[0].trim();
  return { proto, host };
}

export default class CalendarController extends BaseController {
  static postOnlyActions = ['resetFeed', 'book'];

  constructor(props) {
    super(props);
  }

  async #calendar() {
    const name = String(this.query?.name ?? '').trim();
    const row = name && await loopar.db.getRow(CALENDAR, name, ['name', 'feed_token']);
    if (!row) loopar.throw({ code: 404, message: `Calendar ${name} not found.` });
    return row;
  }

  async #setToken(name) {
    const token = newToken();
    // Plain column write: the link is not an edit of the calendar.
    await loopar.db.query(CALENDAR).where({ name }).update({ feed_token: token });
    return token;
  }

  #feedUrl(token) {
    const { proto, host } = origin();
    // `/api/`: the route that answers a GET with the action's own response
    // (without it a GET renders the desk page).
    return `${proto}://${host}/api/Calendar/feed?token=${token}`;
  }

  /**
   * Link to subscribe to a calendar from a phone or another calendar app:
   * `Calendar/feedUrl?name=X`. Whoever has the link reads the events, so it
   * carries a secret token (created on first use). Data endpoint.
   */
  async actionFeedUrl() {
    const calendar = await this.#calendar();
    const token = calendar.feed_token || await this.#setToken(calendar.name);
    return { feed_url: this.#feedUrl(token) };
  }

  /** New link for a calendar; the old one stops working: `Calendar/resetFeed?name=X`. */
  async actionResetFeed() {
    const calendar = await this.#calendar();
    return { feed_url: this.#feedUrl(await this.#setToken(calendar.name)) };
  }

  /**
   * The feed itself (iCalendar text), read by calendar apps without a
   * session: `GET /api/Calendar/feed?token=…`. The token is the only credential.
   */
  async publicActionFeed() {
    const token = String(this.query?.token ?? '').trim();
    // getAll: getDoc only filters by `name`.
    const [calendar] = /^[a-f0-9]{48}$/.test(token)
      ? await loopar.db.getAll(CALENDAR, ['name', 'disabled'], { feed_token: token })
      : [];
    if (!calendar || [1, '1', true].includes(calendar.disabled)) {
      this.res.status(404).set('Content-Type', 'text/plain; charset=utf-8').send('Calendar feed not found.');
      return {};
    }

    const since = `${addDays(toDateTime(new Date()).slice(0, 10), -PAST_DAYS)} 00:00:00`;
    const rows = await loopar.db.query(EVENT)
      .where({ calendar: calendar.name })
      .whereNull('__deleted_at__')
      .where((w) => w.where('starts_at', '>=', since).orWhereIn('repeat', ['Daily', 'Weekly', 'Monthly', 'Yearly']))
      .orderBy('starts_at', 'asc')
      .limit(MAX_EVENTS)
      .select('name', 'title', 'starts_at', 'ends_at', 'all_day', 'location', 'description', 'repeat', 'repeat_interval', 'repeat_days', 'repeat_until');

    const text = buildICal({
      name: calendar.name,
      host: origin().host,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      events: rows.map((row) => ({ ...row, starts_at: toDateTime(row.starts_at), ends_at: toDateTime(row.ends_at) })),
    });

    this.res.status(200)
      .set('Content-Type', 'text/calendar; charset=utf-8')
      .set('Cache-Control', 'private, max-age=300')
      .send(text);
    return {};
  }

  /** The calendar a visitor books on (`calendar` in the query or the body), with its rules. */
  async #bookable() {
    const name = String(this.query?.calendar ?? this.data?.calendar ?? '').trim();
    const calendar = name && await loopar.db.getRow(CALENDAR, name);
    const config = bookingConfig(calendar || {});
    if (!calendar || !config.enabled) loopar.throw({ code: 404, message: 'This calendar does not take bookings.' });
    return { calendar, config };
  }

  /** Free start times of `day` for `duration` minutes, read from the calendar's events. */
  async #slots(calendar, config, day, duration) {
    const fields = loopar.getRef(EVENT, false)?.__CALENDAR__;
    const rows = await loopar.db.query(EVENT)
      .where({ calendar: calendar.name })
      .whereNull('__deleted_at__')
      .where('starts_at', '<=', `${day} 23:59:59`)
      .where((w) => w.where('ends_at', '>=', `${day} 00:00:00`).orWhereIn('repeat', ['Daily', 'Weekly', 'Monthly', 'Yearly']))
      .select('starts_at', 'ends_at', 'all_day', 'repeat', 'repeat_interval', 'repeat_days', 'repeat_until');
    const events = rows.map((row) => ({ ...row, starts_at: toDateTime(row.starts_at), ends_at: toDateTime(row.ends_at) }));
    return freeSlots({ day, duration, config, busy: busyRanges(events, fields, day), now: toDateTime(new Date()) });
  }

  /**
   * Booking rules of a calendar for the website's booking element:
   * `Calendar/booking?calendar=X` → days open, durations, how far ahead.
   */
  async publicActionBooking() {
    const { calendar, config } = await this.#bookable();
    const today = toDateTime(new Date()).slice(0, 10);
    return {
      booking: {
        calendar: calendar.name,
        days: config.days,
        durations: config.durations,
        today,
        last_day: addDays(today, config.ahead),
        time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      },
    };
  }

  /** Free times of a day: `Calendar/slots?calendar=X&date=YYYY-MM-DD&duration=30`. */
  async publicActionSlots() {
    const { calendar, config } = await this.#bookable();
    const day = String(this.query?.date ?? '');
    if (!isDay(day)) loopar.throw({ code: 400, message: 'date must be a day (YYYY-MM-DD).' });
    return { slots: await this.#slots(calendar, config, day, parseInt(this.query?.duration, 10)) };
  }

  /**
   * Books a time: creates the Event on the calendar. The time is checked
   * again here (two visitors may have seen the same free slot), and the
   * visitor must pass the site's captcha.
   */
  async publicActionBook() {
    const body = this.data || {};
    const text = (value, max) => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
    // Honeypot: a bot that fills it gets the same answer as a person.
    if (text(body._hp, 10)) return { booked: true };
    await verifyCaptcha(loopar, body.captcha_token, this.req?.ip);

    const { calendar, config } = await this.#bookable();
    const day = String(body.date ?? '');
    const time = String(body.time ?? '');
    const duration = parseInt(body.duration, 10);
    const name = text(body.name, 120);
    const email = text(body.email, 190);
    const phone = text(body.phone, 40);
    const notes = String(body.notes ?? '').trim().slice(0, 2000);

    if (!name) loopar.throw({ code: 400, message: 'Your name is required.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) loopar.throw({ code: 400, message: 'A valid email is required.' });
    if (!isDay(day) || minutesOf(time) === null) loopar.throw({ code: 400, message: 'Choose a day and a time.' });

    const slots = await this.#slots(calendar, config, day, duration);
    if (!slots.includes(time)) loopar.throw({ code: 409, message: 'That time was just taken. Please choose another one.' });

    const start = `${day} ${time}:00`;
    const event = await scheduleEvent({
      title: name,
      starts_at: start,
      ends_at: addMinutes(start, duration),
      calendar: calendar.name,
      description: notes,
      contact_name: name,
      contact_email: email,
      contact_phone: phone,
    }, { booking: true });

    const when = `${day} ${time}`;
    const safe = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const mail = async (to, subject, lines) => {
      try {
        await loopar.mail.send({ to, subject, html: lines.filter(Boolean).map((l) => `<p>${l}</p>`).join('') });
      } catch (error) {
        // The booking stands even when an email can't go out.
        console.error(`[calendar] booking email for ${event} failed:`, error.message);
      }
    };
    // Not awaited: the visitor gets the confirmation screen at once, the emails follow.
    mail([email], `Booking confirmed: ${when}`, [`<strong>${safe(calendar.name)}</strong>`, `${safe(when)} · ${duration} min`]);
    const notify = text(calendar.booking_email, 190);
    if (notify) {
      mail([notify], `New booking: ${name} · ${when}`, [
        `<strong>${safe(name)}</strong> · ${safe(email)}${phone ? ` · ${safe(phone)}` : ''}`,
        `${safe(when)} · ${duration} min`,
        notes ? safe(notes).replace(/\n/g, '<br>') : '',
      ]);
    }

    return { booked: true, date: day, time, duration };
  }
}
