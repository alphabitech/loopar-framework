import { fileManage } from "../file-manage.js";
import { loopar } from "../loopar.js";

const CAROUSEL_LIKE_ELEMENTS = new Set([
  "carousel",
  "banner_image",
  "gallery",
]);

// Render-time data injected by parseDocStructure that must never persist.
// NOTE: not every "_"-prefixed key is ephemeral (e.g. a link's `_target`
// is authored data), so this is an explicit list, not a prefix rule.
const EPHEMERAL_DATA_KEYS = ["_cookie_index", "preloaded", "rendered_value"];

/**
 * Inverse of parseDocStructure, for persistence: strips everything the
 * server injects into `field.data` at render time, so an edited structure
 * coming back from the designer doesn't round-trip render payloads into
 * the saved document (rows from getList, markdown HTML, cookie indexes...).
 */
export function stripEphemeralDocStructure(fields) {
  return (fields || []).map((field) => {
    if (field?.data && typeof field.data === "object") {
      for (const key of EPHEMERAL_DATA_KEYS) {
        delete field.data[key];
      }
      if (field.element === GALLERY && field.data.source === "Server") {
        //delete field.data.images;
      }
    }
    if (Array.isArray(field?.elements)) {
      field.elements = stripEphemeralDocStructure(field.elements);
    }
    return field;
  });
}

/**
 * Injects the current request's saved slide index (cookie) into a
 * carousel-like field's data as `_cookie_index`, so SSR and client
 * hydrate from the same snapshot instead of each reading the cookie
 * on their own (the client would see a fresher value → hydration
 * mismatch). Stripped on save by stripEphemeralDocStructure.
 */
function injectCookieIndex(field) {
  const node = field.node || field.key || field.data?.key;
  if (!CAROUSEL_LIKE_ELEMENTS.has(field.element) || !node) return;
  try {
    const saved = loopar.cookie?.get?.(node);
    if (saved != null && saved !== "") {
      (field.data ??= {})._cookie_index = String(saved);
    }
  } catch (_) { /* cookie store unavailable; client will fall back */ }
}

/**
 * Walks a doc_structure tree injecting `_cookie_index` into every
 * carousel-like element. Used by render paths that do NOT run the full
 * parseDocStructure (e.g. rawValues() → DESIGNER field for the form/
 * designer view), which otherwise ship the structure without the cookie
 * snapshot and hydrate inconsistently.
 */
export function injectCookieIndexes(fields) {
  if (!Array.isArray(fields)) return fields;
  for (const field of fields) {
    if (!field || typeof field !== "object") continue;
    injectCookieIndex(field);
    if (Array.isArray(field.elements)) injectCookieIndexes(field.elements);
  }
  return fields;
}

function buildEntitySchema(entityName) {
  const ref = loopar.getRef(entityName);
  if (!ref) return [];
  let entityConfig;
  try {
    entityConfig = fileManage.getConfigFile(entityName, ref.__ROOT__);
  } catch {
    return [];
  }
  if (!entityConfig?.doc_structure) return [];
  const tree = loopar.utils.JSONparse(entityConfig.doc_structure, []);
  return flattenSchema(tree);
}

function flattenSchema(nodes) {
  const out = [];
  for (const node of (nodes || [])) {
    const elem = node?.element;
    const data = node?.data || {};
    if (["row", "col", "card", "section", "tabs", "tab", "generic", "div"].includes(elem)) {
      if (data.label && elem === "card") {
        out.push({ element: "_section", label: data.label, name: data.name || null });
      }
      if (node.elements) out.push(...flattenSchema(node.elements));
      continue;
    }
    if (!data.name) continue;

    if (["parent_id", "parent_document"].includes(data.name)) continue;
    out.push({
      element: elem,
      name: data.name,
      label: data.label || null,
      multiple: data.multiple ? 1 : 0,
      format: data.format || null,
      options: data.options || null,
      placeholder: data.placeholder || null,
      show_in_card: data.show_in_card ? 1 : 0,
      show_in_detail: data.show_in_detail ? 1 : 0,
      hidden: data.hidden ? 1 : 0,
    });
  }
  return out;
}

/**
 * Pre-process a doc_structure on the server before render.
 *
 * Mutates each element's `data` in-place with whatever the element needs
 * to be SSR-renderable: MARKDOWN gets its HTML, REVIEW gets its rows, and
 * COLLECTION (a generic data-backed gallery) gets its detail item or its
 * paginated list — driven by `requestContext` from the current request.
 *
 * @param {Array}  doc_structure
 * @param {boolean} renderMarkdown
 * @param {string} document_name
 * @param {Object} [requestContext]
 * @param {string} [requestContext.slug]
 * @param {string} [requestContext.app]
 * @param {Object} [requestContext.query]
 */
export const parseDocStructure = async (
  doc_structure,
  renderMarkdown = true,
  document_name,
  requestContext = null,
  app
) => {
  doc_structure = loopar.utils.JSONparse(doc_structure, doc_structure);

  return Promise.all(
    doc_structure.map(async (field) => {
      field.data ??= {};
      field.node ??= field.key || field.data.key || loopar.getUniqueKey();

      if (field.element === MARKDOWN && renderMarkdown) {
        field.data.value = loopar.markdownRenderer(field.data.value);
      }

      if (field.element === REVIEW) {
        field.data.reviews = await loopar.db.getAll("Review", ["*"], {
          parent_id: document_name,
          approved: 1
        });
      }

      if (field.element === EXAMPLE_VIEWER && renderMarkdown) {
        field.data.rendered_value = loopar.markdownRenderer(
          loopar.utils.isJSON(field.data.value)
            ? JSON.stringify(JSON.parse(field.data.value), null, 3)
            : ""
        );
      }

      if (field.element === COLLECTION) {
        await preloadCollection(field, requestContext);
      }

      injectCookieIndex(field);

      if (field.element === COLLECTION_VIEW) {
        await preloadCollectionView(field, requestContext);
      }

      if(field.element == GALLERY && field.data.source == "Server"){
        const m = await loopar.newDocument("File Manager", {app});
        m.pageSize = parseInt(field.data.page_size || 10);
        const list = await m.getList();
        field.data.images = list;
      }

      if (field.elements) {
        field.elements = await parseDocStructure(field.elements, renderMarkdown, document_name, requestContext, app);
      }

      return field;
    })
  );
};

/**
 * Internal — fills field.data.preloaded for a COLLECTION element.
 * COLLECTION only ever renders a paginated LIST. The detail of a single
 * item is handled by the COLLECTION_VIEW element (preloadCollectionView).
 */
async function preloadCollection(field, requestContext) {
  const entityName = field.data?.options ? String(field.data.options).trim() : null;
  if (!entityName) {
    field.data.preloaded = { mode: "list", items: [], total: 0, fields: [], error: "missing_options" };
    return;
  }

  // Guard: if the entity isn't installed (or doesn't exist in refs), bail
  // gracefully so the page still renders the rest of the doc_structure.
  const ref = loopar.getRef(entityName);
  if (!ref) {
    field.data.preloaded = { mode: "list", items: [], total: 0, fields: [], error: "unknown_entity" };
    return;
  }

  // Schema for the default renderer (so a new entity needs no React code).
  const schema = buildEntitySchema(entityName);

  const ctx = requestContext || {};
  const app = ctx.app ? String(ctx.app).trim() : null;
  const q = ctx.query || {};

  try {
    const pageNum = clampInt(q.page ?? field.data.page, 1, 1000, 1);
    const pageSize = clampInt(
      q.page_size ?? field.data.page_size,
      1, 48,
      field.data.page_size ? parseInt(field.data.page_size, 10) || 12 : 12
    );
    const featuredOnly =
      field.data.featured_only === 1 ||
      field.data.featured_only === "1" ||
      field.data.featured_only === true ||
      q.featured_only === "1" ||
      q.featured_only === "true";
    const tag = q.tag ?? field.data.tag;
    const category = q.category ?? field.data.category;

    const fields = ref.__FIELDS__ || [];
    const has = (name) => fields.some(f => (f?.data?.name ?? f) === name);

    const filter = { published: 1 };
    if (app) filter.app = app;
    if (featuredOnly && has("featured")) filter.featured = 1;
    if (category && has("category")) filter.category = String(category).trim();

    let qb = loopar.db.qx()(entityName)
      .select("*")
      .where(filter)
      .whereNull("__deleted_at__");
    if (tag && has("tags")) qb = qb.where("tags", "like", `%${String(tag).trim()}%`);

    let countQb = loopar.db.qx()(entityName)
      .count({ count: "id" })
      .where(filter)
      .whereNull("__deleted_at__");
    if (tag && has("tags")) countQb = countQb.where("tags", "like", `%${String(tag).trim()}%`);

    const orderBy = [];
    if (has("featured")) orderBy.push({ column: "featured", order: "desc" });
    if (has("order")) orderBy.push({ column: "order", order: "asc" });
    orderBy.push({ column: "__created_at__", order: "desc" });

    const [rows, countRow] = await Promise.all([
      qb.orderBy(orderBy).limit(pageSize).offset((pageNum - 1) * pageSize),
      countQb.first(),
    ]);

    const total = Number(countRow?.count || 0);

    field.data.preloaded = {
      mode: "list",
      items: rows.map(parseRowTags),
      total,
      page: pageNum,
      page_size: pageSize,
      total_pages: Math.max(1, Math.ceil(total / pageSize)),
      fields: schema,
    };
  } catch (err) {
    loopar.warn?.(`COLLECTION preload failed for entity=${entityName}: ${err?.message || err}`);
    field.data.preloaded = { mode: "list", items: [], total: 0, fields: schema, error: "fetch_failed" };
  }
}

/**
 * Internal — fills field.data.preloaded for a COLLECTION_VIEW element.
 * Resolves ONE published item by slug (+ app scope) and flags
 * `requestContext._anyDetailMatched` so the controller can 404 a bogus
 * slug. `mode` is always "detail"; `item` is null when nothing matches.
 */
async function preloadCollectionView(field, requestContext) {
  const entityName = field.data?.options ? String(field.data.options).trim() : null;
  if (!entityName) {
    field.data.preloaded = { mode: "detail", item: null, fields: [], error: "missing_options" };
    return;
  }

  const ref = loopar.getRef(entityName);
  if (!ref) {
    field.data.preloaded = { mode: "detail", item: null, fields: [], error: "unknown_entity" };
    return;
  }

  const schema = buildEntitySchema(entityName);
  const ctx = requestContext || {};
  const slug = ctx.slug ? String(ctx.slug).trim() : null;
  const app = ctx.app ? String(ctx.app).trim() : null;

  if (!slug) {
    field.data.preloaded = { mode: "detail", item: null, fields: schema, error: "missing_slug" };
    return;
  }

  try {
    const filter = { slug, published: 1 };
    if (app) filter.app = app;
    const row = await loopar.db.qx()(entityName)
      .select("*")
      .where(filter)
      .whereNull("__deleted_at__")
      .first();

    if (row) {
      field.data.preloaded = { mode: "detail", item: parseRowTags(row), fields: schema };
      if (requestContext) {
        requestContext._anyDetailMatched = true;
        requestContext._detailTitle ??= row.title || null;
      }
      return;
    }
    // Slug didn't resolve — controller will surface a 404.
    field.data.preloaded = { mode: "detail", item: null, fields: schema };
  } catch (err) {
    loopar.warn?.(`COLLECTION_VIEW preload failed for entity=${entityName}: ${err?.message || err}`);
    field.data.preloaded = { mode: "detail", item: null, fields: schema, error: "fetch_failed" };
  }
}

function clampInt(v, min, max, fallback) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function parseRowTags(row) {
  if (!row || typeof row !== "object") return row;
  if (typeof row.tags === "string") {
    return {
      ...row,
      tags: row.tags.split(",").map(s => s.trim()).filter(Boolean),
    };
  }
  return row;
}

export const parseDocument = (entity, doc) => {
  const ref = loopar.getRef(entity);
  const structure = JSON.parse(
    fileManage.getConfigFile(entity, ref.__ROOT__).doc_structure
  );

  const fieldMap = new Map();

  const buildFieldMap = (fields) => {
    fields.forEach((field) => {
      fieldMap.set(field.data.name, field);
      if (field.elements) buildFieldMap(field.elements);
    });
  };

  buildFieldMap(structure);

  Object.entries(doc || {}).forEach(([key, value]) => {
    const field = fieldMap.get(key);
    if (field?.element === MARKDOWN_INPUT) {
      doc[key] = loopar.markdownRenderer(value);
    }
  });

  return doc;
};