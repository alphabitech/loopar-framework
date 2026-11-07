'use strict';

import { BaseController, loopar } from 'loopar';

const PUBLIC_FIELDS = [
  'name',
  'title',
  'slug',
  'app',
  'published',
  'featured',
  'order',
  'category',
  'tags',
  'tagline',
  'summary',
  'icon',
  'cover_image',
  'pricing_model',
  'price',
  'currency',
  'price_unit',
  'duration_estimate',
  'cta_label',
  'cta_url',
  '__created_at__',
];

const DETAIL_FIELDS = [
  ...PUBLIC_FIELDS,
  'description',
  'deliverables',
  'not_included',
  'images',
  'cta_secondary_label',
  'cta_secondary_url',
];

function clampInt(v, min, max, fallback) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function parseTags(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function pickApp(provided) {
  if (provided && String(provided).trim()) return String(provided).trim();
  const webApp = loopar.webApp;
  return webApp?.name || null;
}

export default class ServiceController extends BaseController {
  constructor(props) {
    super(props);
  }

  async publicActionPublicList() {
    const q = this.query || {};
    const app = pickApp(q.app);

    if (!app) {
      return { items: [], total: 0, page: 1, page_size: 0 };
    }

    const page = clampInt(q.page, 1, 1000, 1);
    const pageSize = clampInt(q.page_size, 1, 48, 12);
    const featuredOnly = q.featured_only === '1' || q.featured_only === 'true';
    const excludeFeatured = !featuredOnly && (q.exclude_featured === '1' || q.exclude_featured === 'true');
    const tag = q.tag ? String(q.tag).trim() : null;
    const category = q.category ? String(q.category).trim() : null;

    const filter = { app, published: 1 };
    if (featuredOnly) filter.featured = 1;
    if (category) filter.category = category;

    let qb = loopar.db.qx()('Service')
      .select(PUBLIC_FIELDS)
      .where(filter)
      .whereNull('__deleted_at__');
    if (excludeFeatured) qb = qb.where((b) => b.whereNull('featured').orWhere('featured', 0));

    if (tag) qb = qb.where('tags', 'like', `%${tag}%`);

    let countQb = loopar.db.qx()('Service')
      .count({ count: 'id' })
      .where(filter)
      .whereNull('__deleted_at__');
    if (excludeFeatured) countQb = countQb.where((b) => b.whereNull('featured').orWhere('featured', 0));

    if (tag) countQb = countQb.where('tags', 'like', `%${tag}%`);

    const [rows, countRow] = await Promise.all([
      qb
        .orderBy([
          { column: 'featured', order: 'desc' },
          { column: 'order', order: 'asc' },
          { column: 'title', order: 'asc' },
        ])
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      countQb.first(),
    ]);

    const total = Number(countRow?.count || 0);

    return {
      items: rows.map(r => ({ ...r, tags: parseTags(r.tags) })),
      total,
      page,
      page_size: pageSize,
      total_pages: Math.max(1, Math.ceil(total / pageSize)),
    };
  }

  async publicActionPublicView() {
    const q = this.query || {};
    const slug = q.slug ? String(q.slug).trim() : null;
    const app = pickApp(q.app);

    if (!slug || !app) return null;

    const row = await loopar.db.qx()('Service')
      .select(DETAIL_FIELDS)
      .where({ slug, app, published: 1 })
      .whereNull('__deleted_at__')
      .first();

    if (!row) return null;

    return { ...row, tags: parseTags(row.tags) };
  }
}
