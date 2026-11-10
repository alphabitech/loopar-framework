'use strict';

/**
 * Element-type migrations for stored doc_structures.
 *
 * When a page-builder element is renamed, merged into another one or removed,
 * the trees already saved (app JSON files and every tenant's meta rows) are
 * rewritten here instead of keeping the old element alive as an alias.
 *
 * `migrateDocStructure` is pure (no imports) so it can also run over the app
 * JSON files from a script. `migrateElementsInDatabase` replays it on the
 * current tenant at boot, once per ELEMENT_MIGRATION_VERSION (a marker file
 * in the tenant folder records the last version applied).
 */

const appendClass = (data, cls) => {
  data.class = [data.class, cls].filter(Boolean).join(" ").trim();
};

/**
 * One entry per legacy element. `to: null` drops the node (and its children).
 * `transform(node, ctx)` mutates the node's data after the rename.
 */
const ELEMENT_MIGRATIONS = {
  // `title` was always an <h1>. The first one of a document keeps h1, the
  // rest become h2 — the "display" size keeps the old look either way.
  title: {
    to: "heading",
    transform(node, ctx) {
      node.data.level = ctx.h1Taken ? "h2" : "h1";
      node.data.size = "display";
      ctx.h1Taken = true;
    },
  },
  subtitle: {
    to: "heading",
    transform(node) {
      node.data.level = "h3";
      node.data.size = "xl";
    },
  },
  // Compact icon + title + text block → feature_card's "plain" variant.
  text_block_icon: {
    to: "feature_card",
    transform(node, ctx) {
      const d = node.data;
      d.variant = "plain";
      d.align = d.orientation === "Vertical" ? "center" : "start";
      d.icon_size = ["sm", "md", "lg", "xl"].includes(d.icon_size) ? d.icon_size : "md";
      delete d.orientation;
      delete d.text_size;
      delete d.rounded;
    },
  },
  // Card → panel with a header and card-like colors.
  card: {
    to: "panel",
    transform(node, ctx) {
      const d = node.data;
      if (d.label) d.title = d.label;
      ctx.moveText(node, "label", "title", { keep: true });
      Object.assign(d, {
        variant: "solid",
        rounded: "lg",
        padding: "lg",
        bg_color: "card",
        bg_opacity: "100",
        border_color: "border",
        border_opacity: "100",
        border_width: "1",
        glow_color: "none",
        backdrop_blur: false,
        hoverable: false,
        focusable: false,
      });
    },
  },
  container: {
    to: "div",
    transform(node) { appendClass(node.data, "min-h-page bg-cover bg-center bg-fixed"); },
  },
  fragment: { to: "div" },
  slider: { to: "carousel" },
  html_block: { to: "markdown" },
  "direct-preview": {
    to: "entity",
    transform(node) {
      const { entity } = node.data;
      delete node.data.entity;
      delete node.data.entity_name;
      node.data.name = entity || node.data.name;
    },
  },
  banner_image: {
    to: "div",
    transform(node) {
      appendClass(node.data, "p-2 lg:p-4");
      if (node.data.full_height) {
        appendClass(node.data, "h-[calc(100vh-var(--spacing-web-header-height))] max-h-[calc(100vh-var(--spacing-web-header-height))]");
      }
      delete node.data.full_height;
    },
  },
  stripe: { to: null },
  stripe_embebed: { to: null },
  // `generic` merged into `div` (tag + text).
  generic: {
    to: "div",
    transform(node, ctx) {
      const d = node.data;
      if (d.inner_text !== undefined) {
        if (!d.text) d.text = d.inner_text;
        delete d.inner_text;
        ctx.moveText(node, "inner_text", "text");
      }
    },
  },
  // Form elements without a component of their own.
  currency: { to: "input", transform(node) { node.data.format = "currency"; } },
  integer: { to: "input", transform(node) { node.data.format = "int"; } },
  decimal: { to: "input", transform(node) { node.data.format = "decimal"; } },
  file_uploader: { to: "file_input" },
  radio_item: { to: null },
  // Quill editor removed: markdown is the one rich text input. Stored values
  // are converted by migrateFieldValues.
  text_editor: { to: "markdown_input", transform(node, ctx) { ctx.convertValues(node, "quill-delta"); } },
  // Tailwind class pickers → plain selects with the same values.
  padding: { to: "select", transform(node) { node.data.options = SPACING_OPTIONS("p"); } },
  margin: { to: "select", transform(node) { node.data.options = SPACING_OPTIONS("m"); } },
};

const SPACING_OPTIONS = (prefix) => Array.from({ length: 10 }, (_, i) => `${prefix}-${i}`).join("\n");

/** Data-key renames inside an element that keeps its type. */
const DATA_KEY_MIGRATIONS = {
  banner: { alling: "align" },
  // One vocabulary: `title` = a block's main text, `description` = its
  // secondary text, `label` = the text of a control.
  feature_card: { label: "title" },
  accordion_item: { label: "title" },
  pricing_plan: { label: "title" },
  business_hours: { label: "title" },
  video_embed: { label: "title" },
  embed: { label: "title" },
  review: { subtitle: "description" },
  collection: { subtitle: "description" },
  stripe_plans: { subtitle: "description" },
  form: { succes_message: "success_message" },
};

/**
 * Elements whose `label` was only the designer's auto-generated name
 * ("Col1", "Title"): nothing renders it, so it is dropped. Direct children of
 * a menu_content keep it — there it is the entry of the side menu.
 */
const FILLER_LABEL_ELEMENTS = new Set([
  "row", "col", "div", "grid", "heading", "paragraph", "text_block", "image", "icon", "banner", "carousel",
  "gallery", "seo", "collection", "contact_form", "particles", "list", "spacer", "stats", "steps",
  "before_after", "contact_links", "accordion", "feature_card", "pricing_plan", "accordion_item",
  "business_hours", "video_embed", "embed", "review", "form", "entity", "menu_content", "example_viewer",
]);

/**
 * Bootstrap-era classes left in stored designs. They did nothing while some
 * elements ignored their `class`; now that every element applies it, a few
 * mean something else in Tailwind (`text-muted` is the muted BACKGROUND
 * color — near-invisible text). Mapped to their Tailwind equivalent, or
 * dropped when the element already controls it (heading sizes).
 */
const CLASS_MIGRATIONS = {
  "text-muted": "text-muted-foreground",
  "font-size-lg": "text-lg",
  "font-size-sm": "text-sm",
  "lead": "text-xl text-muted-foreground",
  "text-sm-left": "sm:text-left",
  "d-block": "block",
  "d-none": "hidden",
  "d-flex": "flex",
  "img-fluid": "max-w-full h-auto",
  "mb-md-0": "md:mb-0",
};
const HEADING_ONLY_CLASS = /^display-\d$/;

function migrateClass(node) {
  const raw = node.data?.class;
  if (typeof raw !== "string" || !raw.trim()) return false;
  const out = [];
  for (const token of raw.split(/\s+/).filter(Boolean)) {
    if (HEADING_ONLY_CLASS.test(token)) continue; // the heading's `size` sets it
    if (token === "lead" && node.element === "heading") continue;
    out.push(CLASS_MIGRATIONS[token] ?? token);
  }
  const next = [...new Set(out.join(" ").split(" "))].join(" ");
  if (next === raw) return false;
  node.data.class = next;
  return true;
}

const WRITE_POLICY_DEFAULTS = new Set([undefined, null, "", "editable"]);
const truthy = (v) => v === true || v === 1 || v === "1" || v === "true";

/** Rules applied to every node after its element migration. */
function migrateNodeData(node, parent, ctx) {
  const d = node.data;
  let changed = false;

  // Legacy flags folded into the field write policy.
  if ("set_only_time" in d) {
    if (truthy(d.set_only_time) && WRITE_POLICY_DEFAULTS.has(d.write_policy)) d.write_policy = "create_only";
    delete d.set_only_time;
    changed = true;
  }
  if ("readonly" in d) {
    if (truthy(d.readonly) && WRITE_POLICY_DEFAULTS.has(d.write_policy)) d.write_policy = "display_only";
    delete d.readonly;
    changed = true;
  }
  if ("mandatory" in d) {
    if (truthy(d.mandatory) && !truthy(d.required)) d.required = 1;
    delete d.mandatory;
    changed = true;
  }

  if (migrateClass(node)) changed = true;

  // Selects state where their options come from (one static line used to be
  // read as an entity name).
  if (node.element === "select" && typeof d.options === "string" && d.options.trim() && !d.options_source) {
    d.options_source = d.options.includes("\n") ? "static" : "entity";
    changed = true;
  }

  if (FILLER_LABEL_ELEMENTS.has(node.element) && "label" in d && parent?.element !== "menu_content") {
    delete d.label;
    ctx.dropText(node, "label");
    changed = true;
  }
  return changed;
}

export const LEGACY_ELEMENTS = Object.freeze(Object.keys(ELEMENT_MIGRATIONS));

/** Bump when a migration is added: tenants re-run the database pass once. */
export const ELEMENT_MIGRATION_VERSION = 4;

/**
 * Migrates a doc_structure (array of nodes, or its JSON text).
 * Returns [structure, changed]; the input is never mutated and the output
 * keeps the input's form (text in → text out).
 */
export function migrateDocStructure(structure) {
  const isText = typeof structure === "string";
  let nodes = structure;
  if (isText) {
    try { nodes = JSON.parse(structure); } catch { return [structure, false]; }
  }
  if (!Array.isArray(nodes)) return [structure, false];

  let changed = false;
  const textMoves = [];
  const valueConversions = [];
  const ctx = {
    h1Taken: false,
    // Translations are stored per node and prop: a renamed prop moves them too.
    moveText(node, from, to, { keep = false } = {}) {
      const key = node.node ?? node.key ?? node.data?.key;
      if (key != null) textMoves.push({ key, from, to, keep });
    },
    dropText(node, prop) {
      const key = node.node ?? node.key ?? node.data?.key;
      if (key != null) textMoves.push({ key, from: prop, to: null });
    },
    // Values of a field stored in its records need converting too.
    convertValues(node, kind) {
      if (node.data?.name) valueConversions.push({ field: node.data.name, kind });
    },
  };

  // A heading migrated earlier (or authored) at level h1 owns the page's h1.
  const scanH1 = (list) => list.forEach((n) => {
    if (n?.element === "heading" && n.data?.level === "h1") ctx.h1Taken = true;
    if (Array.isArray(n?.elements)) scanH1(n.elements);
  });
  scanH1(nodes);

  const walk = (list, parent = null) => list.reduce((acc, original) => {
    if (!original || typeof original !== "object") { acc.push(original); return acc; }
    const node = { ...original, data: { ...(original.data || {}) } };

    const migration = ELEMENT_MIGRATIONS[node.element];
    if (migration) {
      changed = true;
      if (migration.to === null) return acc;
      node.element = migration.to;
      migration.transform?.(node, ctx);
    }

    const keyMap = DATA_KEY_MIGRATIONS[node.element];
    if (keyMap) {
      for (const [from, to] of Object.entries(keyMap)) {
        if (from in node.data) {
          if (!(to in node.data)) node.data[to] = node.data[from];
          delete node.data[from];
          ctx.moveText(node, from, to);
          changed = true;
        }
      }
    }

    if (migrateNodeData(node, parent, ctx)) changed = true;

    if (Array.isArray(node.elements)) node.elements = walk(node.elements, node);
    acc.push(node);
    return acc;
  }, []);

  const out = walk(nodes);
  if (!changed) return [structure, false, textMoves, valueConversions];
  return [isText ? JSON.stringify(out) : out, true, textMoves, valueConversions];
}

/**
 * Applies the prop moves of migrateDocStructure to a `translations` value
 * ({ lang: { nodeKey: { prop: entry } } }, JSON text or object).
 * Returns [translations, changed]; keeps the input's form.
 */
export function migrateTranslations(translations, textMoves = []) {
  if (!translations || !textMoves.length) return [translations, false];
  const isText = typeof translations === "string";
  let all = translations;
  if (isText) {
    try { all = JSON.parse(translations); } catch { return [translations, false]; }
  }
  if (!all || typeof all !== "object") return [translations, false];

  let changed = false;
  const out = {};
  for (const [lang, layer] of Object.entries(all)) {
    const next = layer && typeof layer === "object" ? { ...layer } : layer;
    for (const { key, from, to, keep } of textMoves) {
      const texts = next?.[key];
      if (!texts || !(from in texts)) continue;
      if (to === null) {
        const { [from]: _dropped, ...rest } = texts;
        next[key] = rest;
        changed = true;
        continue;
      }
      if (to in texts) continue;
      next[key] = { ...texts, [to]: texts[from] };
      if (!keep) delete next[key][from];
      changed = true;
    }
    out[lang] = next;
  }
  if (!changed) return [translations, false];
  return [isText ? JSON.stringify(out) : out, true];
}

/** Migrates a document record: its doc_structure and, with it, its translations. */
export function migrateDocument({ doc_structure, translations }) {
  const [structure, changed, textMoves, valueConversions] = migrateDocStructure(doc_structure);
  if (!changed) return { changed: false };
  const [nextTranslations, translationsChanged] = migrateTranslations(translations, textMoves);
  return {
    changed: true,
    doc_structure: structure,
    ...(translationsChanged ? { translations: nextTranslations } : {}),
    valueConversions,
  };
}

/* ------------------------------------------------------- record values */

/**
 * Quill Delta ({ ops: [...] } or [...]) → Markdown. Covers what the old
 * editor produced: bold/italic/strike/code/link inline, headers, lists,
 * blockquotes and code blocks per line, images.
 */
export function quillDeltaToMarkdown(value) {
  let delta = value;
  if (typeof delta === "string") {
    const t = delta.trim();
    if (!t.startsWith("{") && !t.startsWith("[")) return delta;
    try { delta = JSON.parse(t); } catch { return value; }
  }
  const ops = Array.isArray(delta) ? delta : delta?.ops;
  if (!Array.isArray(ops)) return typeof value === "string" ? value : "";

  const lines = [];
  let current = "";
  const inline = (text, a = {}) => {
    if (!text) return "";
    let t = text;
    if (a.code) t = "`" + t + "`";
    if (a.bold) t = `**${t}**`;
    if (a.italic) t = `*${t}*`;
    if (a.strike) t = `~~${t}~~`;
    if (a.link) t = `[${t}](${a.link})`;
    return t;
  };

  for (const op of ops) {
    const a = op.attributes || {};
    if (typeof op.insert === "object" && op.insert?.image) {
      current += `![](${op.insert.image})`;
      continue;
    }
    if (typeof op.insert !== "string") continue;
    const parts = op.insert.split("\n");
    parts.forEach((part, i) => {
      current += inline(part, a);
      if (i < parts.length - 1) {
        // A newline carries the attributes of the line it closes.
        let line = current;
        if (a.header) line = `${"#".repeat(Math.min(6, a.header))} ${line}`;
        else if (a.list === "ordered") line = `1. ${line}`;
        else if (a.list) line = `- ${line}`;
        else if (a.blockquote) line = `> ${line}`;
        else if (a["code-block"]) line = "    " + line;
        lines.push(line);
        current = "";
      }
    });
  }
  if (current) lines.push(current);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

const VALUE_CONVERTERS = { "quill-delta": quillDeltaToMarkdown };

/**
 * Rewrites every meta row's doc_structure of the current tenant. Idempotent.
 */
export async function migrateElementsInDatabase(loopar, { fs, path } = {}) {
  if (!loopar.__installed__) return;
  const marker = fs && path && loopar.tenantPath ? path.join(loopar.tenantPath, ".element-migration") : null;
  if (marker) {
    try { if (Number(fs.readFileSync(marker, "utf8")) >= ELEMENT_MIGRATION_VERSION) return; } catch { /* first run */ }
  }

  const q = () => loopar.db.qx();
  const tables = [...new Set(["Entity", ...Object.keys(loopar.getTypes?.() || {})])];
  let updated = 0;
  const conversions = [];

  for (const table of tables) {
    if (!(await q().schema.hasTable(table)) || !(await q().schema.hasColumn(table, "doc_structure"))) continue;

    const hasTranslations = await q().schema.hasColumn(table, "translations");
    const hasName = await q().schema.hasColumn(table, "name");
    const rows = await q()(table).select("id", "doc_structure", ...(hasName ? ["name"] : []), ...(hasTranslations ? ["translations"] : []));

    for (const row of rows) {
      const { changed, valueConversions = [], ...values } = migrateDocument(row);
      if (!changed) continue;
      await q()(table).where({ id: row.id }).update(values);
      updated++;
      if (valueConversions.length && row.name) conversions.push({ table: row.name, fields: valueConversions });
    }
  }

  // Records of entities whose field type changed (text_editor → markdown_input).
  for (const { table, fields } of conversions) {
    if (!(await q().schema.hasTable(table))) continue;
    for (const { field, kind } of fields) {
      const convert = VALUE_CONVERTERS[kind];
      if (!convert || !(await q().schema.hasColumn(table, field))) continue;
      for (const row of await q()(table).select("id", field).whereNotNull(field)) {
        const next = convert(row[field]);
        if (next !== row[field]) await q()(table).where({ id: row.id }).update({ [field]: next });
      }
    }
  }

  if (updated) console.log(`[element-migration] ${loopar.tenantId}: migrated ${updated} document(s)`);
  if (marker) {
    try { fs.writeFileSync(marker, String(ELEMENT_MIGRATION_VERSION)); } catch { /* retried next boot */ }
  }
}
