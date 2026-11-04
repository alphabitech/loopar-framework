'use strict';

/**
 * Which backups to keep. Scheduled backups follow grandfather-father-son:
 * the newest of each of the last `daily` days, `weekly` ISO weeks and
 * `monthly` months. Safety snapshots (pre-update, pre-restore) and manual
 * backups keep their own most recent N. Pure: takes [{ name, kind, date }]
 * and returns the names to delete.
 */

const dayKey = (d) => d.toISOString().slice(0, 10);
const monthKey = (d) => d.toISOString().slice(0, 7);
function weekKey(d) {
  // ISO week: Thursday of the same week decides the year.
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const year = t.getUTCFullYear();
  const week = Math.ceil(((t - Date.UTC(year, 0, 1)) / 86400000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

export const DEFAULT_RETENTION = Object.freeze({ daily: 7, weekly: 4, monthly: 3, manual: 10, safety: 5 });

export function backupsToDelete(backups, retention = {}) {
  const r = { ...DEFAULT_RETENTION, ...Object.fromEntries(Object.entries(retention).filter(([, v]) => v !== undefined && v !== null && v !== '')) };
  const num = (v) => Math.max(0, Number(v) || 0);
  const keep = new Set();
  const newest = [...backups].sort((a, b) => b.date - a.date);

  const scheduled = newest.filter((b) => b.kind === 'scheduled');
  for (const [limit, key] of [[num(r.daily), dayKey], [num(r.weekly), weekKey], [num(r.monthly), monthKey]]) {
    const seen = new Set();
    for (const b of scheduled) {
      const k = key(b.date);
      if (seen.has(k)) continue;
      if (seen.size >= limit) break;
      seen.add(k);
      keep.add(b.name);
    }
  }
  newest.filter((b) => b.kind === 'manual').slice(0, num(r.manual)).forEach((b) => keep.add(b.name));
  newest.filter((b) => b.kind === 'pre-update' || b.kind === 'pre-restore').slice(0, num(r.safety)).forEach((b) => keep.add(b.name));
  // Anything of an unknown kind (an uploaded archive) is never pruned.
  newest.filter((b) => !['scheduled', 'manual', 'pre-update', 'pre-restore'].includes(b.kind)).forEach((b) => keep.add(b.name));

  return newest.filter((b) => !keep.has(b.name)).map((b) => b.name);
}
