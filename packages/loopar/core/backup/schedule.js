'use strict';

const DAY_INDEX = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

/**
 * The most recent moment Backup Settings asked for a backup (server-local
 * time): today's (or yesterday's) `at` for daily, the last `weekday` at `at`
 * for weekly. A scheduled backup older than this slot means one is due.
 */
export function lastSlot(settings, now = new Date()) {
  const [h, m] = String(settings.at || '02:30').split(':').map(Number);
  const slot = new Date(now);
  slot.setHours(h || 0, m || 0, 0, 0);
  if (settings.frequency === 'weekly') {
    const target = DAY_INDEX[String(settings.weekday || 'sun').slice(0, 3).toLowerCase()] ?? 0;
    slot.setDate(slot.getDate() - ((slot.getDay() - target + 7) % 7));
    if (slot > now) slot.setDate(slot.getDate() - 7);
  } else if (slot > now) {
    slot.setDate(slot.getDate() - 1);
  }
  return slot;
}
