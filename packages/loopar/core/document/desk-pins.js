'use strict';

import { loopar } from '../loopar.js';

/**
 * Per-user pins of the desk shortcuts menu (top bar grid): one `Desk Pin`
 * record per user holding `[{ link, label, icon }]`. A user who never saved
 * pins gets null, and the menu shows its defaults.
 */
export const DESK_PIN_ENTITY = 'Desk Pin';
const MAX_PINS = 24;

const installed = () => !!loopar.getRef(DESK_PIN_ENTITY, false);
const table = () => loopar.db.qx()(DESK_PIN_ENTITY);

const clip = (value, max) => String(value ?? '').slice(0, max);

/** Desk links only (`/desk/...`), unique, capped. */
export function normalizeDeskPins(pins) {
  const list = typeof pins === 'string' ? loopar.utils.JSONparse(pins, []) : pins;
  if (!Array.isArray(list)) return [];

  const seen = new Set();
  const out = [];
  for (const pin of list) {
    const link = clip(pin?.link, 500);
    if (!link.startsWith('/desk/') || seen.has(link)) continue;
    seen.add(link);
    out.push({ link, label: clip(pin?.label || link, 120), icon: clip(pin?.icon, 60) || null });
    if (out.length >= MAX_PINS) break;
  }
  return out;
}

/** The user's pins, or null when they never saved any (or there is no storage yet). */
export async function readDeskPins(user = loopar.auth?.user?.()) {
  if (!user || user === 'Guest' || !installed()) return null;
  try {
    const row = await table().select('pins_json').where({ name: user }).whereNull('__deleted_at__').first();
    return row ? normalizeDeskPins(row.pins_json) : null;
  } catch (e) {
    console.warn('[desk] pins could not be read:', e?.message || e);
    return null;
  }
}

/** Saves (replaces) the user's pins; returns them normalized. */
export async function writeDeskPins(pins, user = loopar.auth?.user?.()) {
  if (!user || user === 'Guest') loopar.throw({ code: 401, message: 'You must be logged in to pin pages.' });
  if (!installed()) loopar.throw({ code: 404, message: 'Pins are not available: update the loopar app.' });

  const normalized = normalizeDeskPins(pins);
  const values = { pins_json: JSON.stringify(normalized), __deleted_at__: null };

  const row = await table().select('id').where({ name: user }).first();
  if (row) await table().where({ id: row.id }).update(values);
  else await table().insert({ name: user, owner_user: user, ...values });

  return normalized;
}
