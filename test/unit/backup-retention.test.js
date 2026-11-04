import { test } from "node:test";
import assert from "node:assert/strict";
import { backupsToDelete } from "../../packages/loopar/core/backup/retention.js";
import { lastSlot } from "../../packages/loopar/core/backup/schedule.js";

const day = (n, h = 3) => new Date(Date.UTC(2026, 10, 30 - n, h));
const daily = (count) => Array.from({ length: count }, (_, i) => ({ name: `s${i}`, kind: "scheduled", date: day(i) }));

test("scheduled: keeps the newest per day / ISO week / month, deletes the rest", () => {
  const backups = daily(60);
  const del = new Set(backupsToDelete(backups, { daily: 7, weekly: 4, monthly: 3 }));
  const kept = backups.filter((b) => !del.has(b.name));
  // 7 days + older week/month representatives, never more than 7+4+3
  assert.ok(kept.length <= 14 && kept.length >= 7, `kept ${kept.length}`);
  for (let i = 0; i < 7; i++) assert.ok(!del.has(`s${i}`), `the last 7 days stay (s${i})`);
  assert.ok(del.has("s59"), "two months back goes");
});

test("two backups the same day: only the newest counts as that day's", () => {
  const backups = [
    { name: "late", kind: "scheduled", date: new Date(Date.UTC(2026, 10, 30, 23)) },
    { name: "early", kind: "scheduled", date: new Date(Date.UTC(2026, 10, 30, 1)) },
  ];
  assert.deepEqual(backupsToDelete(backups, { daily: 7, weekly: 0, monthly: 0 }), ["early"]);
});

test("manual and safety snapshots keep their own most recent N; uploads are never pruned", () => {
  const backups = [
    ...Array.from({ length: 12 }, (_, i) => ({ name: `m${i}`, kind: "manual", date: day(i) })),
    ...Array.from({ length: 7 }, (_, i) => ({ name: `p${i}`, kind: i % 2 ? "pre-update" : "pre-restore", date: day(i) })),
    { name: "up", kind: "uploaded", date: day(400) },
  ];
  const del = backupsToDelete(backups, { manual: 10, safety: 5 });
  assert.deepEqual(del.filter((n) => n.startsWith("m")).sort(), ["m10", "m11"]);
  assert.deepEqual(del.filter((n) => n.startsWith("p")).sort(), ["p5", "p6"]);
  assert.ok(!del.includes("up"));
});

test("lastSlot(): daily before/after the hour, weekly on the chosen day", () => {
  const at = (iso) => new Date(iso);
  assert.equal(lastSlot({ frequency: "daily", at: "02:30" }, at("2026-11-03T10:00:00")).toString(), at("2026-11-03T02:30:00").toString());
  assert.equal(lastSlot({ frequency: "daily", at: "23:00" }, at("2026-11-03T10:00:00")).toString(), at("2026-11-02T23:00:00").toString());
  // 2026-11-03 is a Tuesday → last Sunday 02:30 is Nov 1
  assert.equal(lastSlot({ frequency: "weekly", weekday: "sun", at: "02:30" }, at("2026-11-03T10:00:00")).toString(), at("2026-11-01T02:30:00").toString());
  assert.equal(lastSlot({ frequency: "weekly", weekday: "tue", at: "12:00" }, at("2026-11-03T10:00:00")).toString(), at("2026-10-27T12:00:00").toString());
});
