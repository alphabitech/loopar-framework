'use strict';

import { BaseDocument, loopar } from 'loopar';
import { ENGAGED_THRESHOLD_MS as ENGAGED_MS } from '../../entities/page-view/page-view-controller.js';
import { isOperator } from './analytics-dashboard-controller.js';

const ENTITY = 'Page View';
const WORKSPACE = 'web';

function getFromDate(days = 30) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    .toISOString()
    .split('T')[0];
}

function hourExpr(dialect) {
  if (dialect.includes('sqlite')) return `CAST(strftime('%H', created_at) AS INTEGER)`;
  if (dialect.includes('postgres')) return `EXTRACT(HOUR FROM created_at)::int`;
  return 'HOUR(created_at)';
}

function referrerHostname(raw) {
  if (!raw || raw === 'Direct') return 'Direct';
  try {
    return new URL(raw).hostname.replace(/^www\./i, '') || 'Direct';
  } catch {
    const cleaned = String(raw)
      .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
      .replace(/^www\./i, '')
      .split('/')[0]
      .split('?')[0]
      .trim();
    return cleaned || 'Direct';
  }
}

export default class AnalyticsDashboard extends BaseDocument {
  constructor(props) { super(props); }

  async data() {
    const [kpis, visits, pages, countries, devices, browsers, referrers, hourly, campaigns] =
      await Promise.all([
        this.getKpis(),
        this.getVisitStats(),
        this.getTopPages(),
        this.getTopCountries(),
        this.getDevices(),
        this.getBrowsers(),
        this.getReferrers(),
        this.getHourly(),
        this.getCampaigns(),
      ]);

    return { kpis, visits, pages, countries, devices, browsers, referrers, hourly, campaigns, sites: await this.getSites(), site: this.site || '', operator: isOperator() };
  }

  async __meta__() {
    return { ...await super.__meta__(), data: await this.data() };
  }

  get from() { return getFromDate(this.days); }

  /** Sites that recorded traffic (for the dashboard's site filter). */
  async getSites() {
    const rows = await loopar.db.query(ENTITY)
      .distinct('site')
      .whereNotNull('site')
      .andWhere('site', '<>', '')
      .orderBy('site');
    return rows.map(r => r.site);
  }

  #baseQuery(from = this.from) {
    const site = this.site;
    return loopar.db.query(ENTITY)
      .where('workspace', WORKSPACE)
      .modify(qb => { if (site) qb.andWhere('site', site); })
      .andWhere('visit_date', '>=', from)
      // Exclude own/logged-in traffic; null-safe so pre-migration rows
      // (is_internal NULL) keep counting.
      .andWhere(function () {
        this.whereNot('is_internal', 1).orWhereNull('is_internal');
      });
  }

  async getVisitStats() {
    return await this.#baseQuery()
      .select('visit_date as stat_date')
      .count('* as total_views')
      .countDistinct('ip_hash as unique_visitors')
      .groupBy('visit_date')
      .orderBy('visit_date', 'asc');
  }

  async getKpis() {
    const knex = loopar.db.knex;
    const days = this.days;
    const from = this.from;
    const prevFrom = getFromDate(days * 2);
    const engagedExpr = knex.raw('SUM(CASE WHEN active_ms >= ? THEN 1 ELSE 0 END) AS engaged_views', [ENGAGED_MS]);

    const [current, previous] = await Promise.all([
      this.#baseQuery(from)
        .count('* as total_views')
        .countDistinct('ip_hash as unique_visitors')
        .countDistinct('document as unique_pages')
        .countDistinct('session_id as sessions')
        .avg('active_ms as avg_active_ms')
        .avg('scroll_depth as avg_scroll_depth')
        .select(engagedExpr)
        // Rows from before the engagement/session fields existed have NULLs;
        // rates must be computed over measured rows only.
        .select(knex.raw('SUM(CASE WHEN active_ms IS NOT NULL THEN 1 ELSE 0 END) AS measured_views'))
        .select(knex.raw(`SUM(CASE WHEN session_id IS NOT NULL AND session_id <> '' THEN 1 ELSE 0 END) AS session_views`))
        .first(),
      this.#baseQuery(prevFrom)
        .andWhere('visit_date', '<', from)
        .count('* as total_views')
        .countDistinct('ip_hash as unique_visitors')
        .countDistinct('session_id as sessions')
        .select(knex.raw('SUM(CASE WHEN active_ms >= ? THEN 1 ELSE 0 END) AS engaged_views', [ENGAGED_MS]))
        .first(),
    ]);

    const num = (v) => +v || 0;
    const cur  = {
      total_views: num(current?.total_views),
      unique_visitors: num(current?.unique_visitors),
      unique_pages: num(current?.unique_pages),
      sessions: num(current?.sessions),
      avg_active_ms: num(current?.avg_active_ms),
      avg_scroll_depth: num(current?.avg_scroll_depth),
      engaged_views: num(current?.engaged_views),
      measured_views: num(current?.measured_views),
      session_views: num(current?.session_views),
    };
    const prev = {
      total_views: num(previous?.total_views),
      unique_visitors: num(previous?.unique_visitors),
      sessions: num(previous?.sessions),
      engaged_views: num(previous?.engaged_views),
    };
    const pct = (now, was) => was > 0 ? Math.round(((now - was) / was) * 100) : 0;
    const rate = (part, whole) => whole > 0 ? Math.round((part / whole) * 100) : 0;

    const engaged_rate = rate(cur.engaged_views, cur.measured_views);

    return {
      total_views: cur.total_views,
      unique_visitors: cur.unique_visitors,
      unique_pages: cur.unique_pages,
      views_diff: pct(cur.total_views, prev.total_views),
      visitors_diff: pct(cur.unique_visitors, prev.unique_visitors),
      // Sessions (rows without session_id — pre-migration — don't count)
      sessions: cur.sessions,
      sessions_diff: pct(cur.sessions, prev.sessions),
      pages_per_session: cur.sessions > 0
        ? Math.round((cur.session_views / cur.sessions) * 10) / 10
        : 0,
      // Engagement
      engaged_views: cur.engaged_views,
      engaged_rate,
      bounce_rate: 100 - engaged_rate,
      avg_active_seconds: Math.round(cur.avg_active_ms / 1000),
      avg_scroll_depth: Math.round(cur.avg_scroll_depth),
      engaged_diff: pct(cur.engaged_views, prev.engaged_views),
    };
  }

  async getTopPages() {
    return await this.#baseQuery()
      .select('document as page')
      .count('* as views')
      .countDistinct('ip_hash as unique_visitors')
      .groupBy('document')
      .orderBy('views', 'desc')
      .limit(10);
  }

  async getTopCountries() {
    const knex = loopar.db.knex;
    return await this.#baseQuery()
      .select(knex.raw('COALESCE(??, ?) AS country', ['country', 'Unknown']))
      .count('* as views')
      .countDistinct('ip_hash as unique_visitors')
      .groupBy('country')
      .orderBy('views', 'desc')
      .limit(10);
  }

  async getDevices() {
    const knex = loopar.db.knex;
    return await this.#baseQuery()
      .select(knex.raw('COALESCE(??, ?) AS device_type', ['device_type', 'desktop']))
      .count('* as views')
      .groupBy('device_type')
      .orderBy('views', 'desc');
  }

  async getBrowsers() {
    const knex = loopar.db.knex;
    return await this.#baseQuery()
      .select(knex.raw('COALESCE(??, ?) AS browser', ['browser', 'Unknown']))
      .count('* as views')
      .groupBy('browser')
      .orderBy('views', 'desc')
      .limit(6);
  }

  async getReferrers() {
    const knex = loopar.db.knex;
    const rows = await this.#baseQuery()
      .select(knex.raw(`COALESCE(NULLIF(??, ''), ?) AS source`, ['referrer', 'Direct']))
      .count('* as views')
      .groupBy('referrer');

    return rows.reduce((acc, row) => {
      const source = referrerHostname(row.source);
      const existing = acc.find(r => r.source === source);
      if (existing) existing.views += +row.views;
      else acc.push({ source, views: +row.views });
      return acc;
    }, []).sort((a, b) => b.views - a.views).slice(0, 8);
  }

  async getCampaigns() {
    return await this.#baseQuery()
      .select('utm_source', 'utm_medium', 'utm_campaign')
      .count('* as views')
      .countDistinct('session_id as sessions')
      .whereNotNull('utm_source')
      .andWhereNot('utm_source', '')
      .groupBy('utm_source', 'utm_medium', 'utm_campaign')
      .orderBy('views', 'desc')
      .limit(10);
  }

  async getHourly() {
    const knex = loopar.db.knex;
    const expr = hourExpr(loopar.db.dialect);

    return await this.#baseQuery()
      .select(knex.raw(`${expr} AS hour`))
      .count('* as views')
      .groupByRaw(expr)
      .orderBy('hour', 'asc');
  }
}
