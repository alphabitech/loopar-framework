'use strict';

/**
 * Data behind Dashboard Charts and Dashboard items. Every query goes through
 * desk-page's scopedQuery: the viewer must be able to list the entity, and
 * an "own" scope narrows it to the viewer's records.
 *
 * Grouping is done here, not in SQL: date bucketing differs between SQLite,
 * MySQL and Postgres, and dashboards read bounded data (MAX_ROWS).
 */
import { loopar } from '../loopar.js';
import { fileManage } from '../file-manage.js';
import { scopedQuery, aggregate } from './desk-page.js';

export const CHART_TYPES = ["bar", "line", "area", "donut"];
const GRAINS = ["day", "week", "month", "year"];
const MAX_ROWS = 100000;
const MAX_BUCKETS = 400;

const pad = (n) => String(n).padStart(2, "0");
const isoDay = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

/** 'YYYY-MM-DD' of a stored date/datetime (string or Date), or null. */
function dayOf(value) {
  if (value == null || value === "") return null;
  if (value instanceof Date) return isNaN(value) ? null : isoDay(value);
  const s = String(value);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

const utc = (day) => new Date(`${day}T00:00:00Z`);

function bucketOf(day, grain) {
  if (grain === "year") return day.slice(0, 4);
  if (grain === "month") return day.slice(0, 7);
  if (grain === "week") {
    const d = utc(day);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));   // Monday
    return isoDay(d);
  }
  return day;
}

function nextBucket(bucket, grain) {
  if (grain === "year") return String(Number(bucket) + 1);
  if (grain === "month") {
    const [y, m] = bucket.split("-").map(Number);
    return m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`;
  }
  const d = utc(bucket);
  d.setUTCDate(d.getUTCDate() + (grain === "week" ? 7 : 1));
  return isoDay(d);
}

/** Every bucket between two, so a series has no holes; the latest MAX_BUCKETS. */
function bucketRange(from, to, grain) {
  const out = [];
  for (let b = from; b <= to && out.length < MAX_BUCKETS * 20; b = nextBucket(b, grain)) out.push(b);
  return out.slice(-MAX_BUCKETS);
}

/** { value: label } of a select field with "value:label" options. */
function optionLabels(ref, field) {
  const cfg = fileManage.getConfigFile(ref.__NAME__, ref.__ROOT__) || {};
  let labels = {};
  const walk = (nodes) => (nodes || []).forEach((node) => {
    if (node?.data?.name === field && node.element === SELECT && typeof node.data.options === "string") {
      for (const option of node.data.options.split("\n")) {
        const [value, label] = option.split(":");
        if (value && label) labels[value.trim()] = label.trim();
      }
    }
    walk(node?.elements);
  });
  walk(loopar.utils.JSONparse(cfg.doc_structure, []));
  return labels;
}

function reduce(values, fn) {
  if (fn === "count") return values.length;
  const nums = values.map(Number).filter(Number.isFinite);
  const sum = nums.reduce((a, b) => a + b, 0);
  return fn === "avg" ? (nums.length ? sum / nums.length : 0) : sum;
}

/**
 * Series of a Dashboard Chart record, as `user` sees it.
 * → { type, label, labels: [], values: [] } | { denied: true } | { issue }
 */
export async function chartData(chart, user = loopar.auth.user()) {
  if (!chart) return { issue: "Chart not found" };

  const type = CHART_TYPES.includes(chart.chart_type) ? chart.chart_type : "bar";
  const q = scopedQuery(chart.entity, chart.filter, user);
  if (!q) return { denied: true };

  const fields = new Set([...(q.ref.__FIELDS__ || []), "__created_at__", "__updated_at__"]);
  const fn = ["sum", "avg"].includes(chart.aggregate) ? chart.aggregate : "count";
  const byTime = chart.group_by !== "field";

  if (!fields.has(chart.x_field)) return { issue: `Field "${chart.x_field || ""}" is not in ${q.ref.__NAME__}` };
  if (fn !== "count" && !fields.has(chart.value_field)) {
    return { issue: `Field "${chart.value_field || ""}" is not in ${q.ref.__NAME__}` };
  }

  const select = [chart.x_field, ...(fn !== "count" ? [chart.value_field] : [])];
  const label = chart.label || chart.name;
  let qb = q.qb.select([...new Set(select)]);

  if (byTime) {
    const grain = GRAINS.includes(chart.time_grain) ? chart.time_grain : "day";
    const span = parseInt(chart.timespan, 10) || 0;
    const today = isoDay(new Date());
    let from = null;
    if (span > 0) {
      const d = utc(today);
      d.setUTCDate(d.getUTCDate() - (span - 1));
      from = isoDay(d);
      qb = qb.where(chart.x_field, ">=", from);
    }

    const groups = {};
    for (const row of await qb.whereNotNull(chart.x_field).limit(MAX_ROWS)) {
      const day = dayOf(row[chart.x_field]);
      if (!day) continue;
      (groups[bucketOf(day, grain)] ??= []).push(row[chart.value_field]);
    }

    const present = Object.keys(groups).sort();
    const start = from ? bucketOf(from, grain) : present[0];
    const end = bucketOf(today, grain) > (present.at(-1) || "") ? bucketOf(today, grain) : present.at(-1);
    const labels = start ? bucketRange(start, end, grain) : [];

    return { type, label, grain, labels, values: labels.map(b => reduce(groups[b] || [], fn)) };
  }

  const groups = {};
  for (const row of await qb.limit(MAX_ROWS)) {
    const key = row[chart.x_field] == null || row[chart.x_field] === "" ? "—" : String(row[chart.x_field]);
    (groups[key] ??= []).push(row[chart.value_field]);
  }

  const names = optionLabels(q.ref, chart.x_field);
  const limit = Math.min(Math.max(parseInt(chart.top_n, 10) || 8, 1), 50);
  const sorted = Object.entries(groups)
    .map(([key, values]) => ({ key, value: reduce(values, fn) }))
    .sort((a, b) => b.value - a.value);

  const top = sorted.slice(0, limit);
  const rest = sorted.slice(limit);
  if (rest.length) top.push({ key: "Other", value: fn === "avg" ? reduce(rest.map(r => r.value), "avg") : rest.reduce((a, r) => a + r.value, 0) });

  return { type, label, labels: top.map(r => names[r.key] || r.key), values: top.map(r => r.value) };
}

export async function getChart(name) {
  if (!name) return null;
  const [row] = await loopar.db.getAll("Dashboard Chart", ["*"], { name });
  return row || null;
}

/** Items of a dashboard, in order. */
export async function dashboardItems(dashboard) {
  const rows = await loopar.db.getAll("Dashboard Item", ["*"], { parent_document: "Dashboard", parent_id: dashboard.id });
  return rows.sort((a, b) => a.id - b.id);
}

/** Data of one dashboard item (a number, or a chart's series). */
export async function dashboardItemData(item, user = loopar.auth.user()) {
  if (item.item_type === "number") {
    return await aggregate({ entity: item.entity, aggregate: item.aggregate, field: item.value_field, filter: item.filter }, user);
  }
  return await chartData(await getChart(item.chart), user);
}

/**
 * { [app]: [{ name, description }] } — dashboards pinned to an app's sidebar,
 * for users who may open dashboards. Read per request: they are records.
 */
export async function sidebarDashboards(user = loopar.auth.user()) {
  if (!loopar.getRef("Dashboard", false)) return {};
  const { PermissionManager } = await import('../auth/PermissionManager.js');
  if (!PermissionManager.can("Dashboard", "view", user)) return {};

  const out = {};
  try {
    const rows = await loopar.db.getAll("Dashboard", ["id", "name", "description", "app"], { in_sidebar: 1 });
    for (const row of rows.sort((a, b) => a.id - b.id)) {
      if (row.app) (out[row.app] ??= []).push({ name: row.name, description: row.description || "" });
    }
  } catch (e) {
    // Table not migrated yet on this tenant.
    return {};
  }
  return out;
}
