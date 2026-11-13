import { withRoot } from "./base/with-root.jsx";
import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { loopar } from "loopar";
import { ChevronLeftIcon, ChevronRightIcon, Loader2 } from "lucide-react";

import DefaultCard from "./collection/default-card.jsx";
import { __ } from "@global/i18n";
import { entityPicker } from "./base/entity-pickers.js";

const cardModules = import.meta.glob("./*-card.jsx", { eager: true });

function lookupCard(entityName) {
  if (!entityName) return DefaultCard;
  const slug = String(entityName)
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .toLowerCase();
  return cardModules[`./${slug}-card.jsx`]?.default || DefaultCard;
}

function Spinner() {
  return (
    <div
      className="flex items-center justify-center py-16 text-muted-foreground"
      aria-busy="true"
      aria-live="polite"
    >
      <Loader2 className="w-6 h-6 animate-spin opacity-70" />
    </div>
  );
}

function Pagination({ page, totalPages, onChange }) {
  if (totalPages <= 1) return null;

  const pages = useMemo(() => {
    const out = [];
    const push = (p) => { if (!out.includes(p)) out.push(p); };
    push(1);
    for (let p = page - 1; p <= page + 1; p++) {
      if (p > 1 && p < totalPages) push(p);
    }
    push(totalPages);
    const withGaps = [];
    for (let i = 0; i < out.length; i++) {
      withGaps.push(out[i]);
      if (i < out.length - 1 && out[i + 1] - out[i] > 1) withGaps.push("…");
    }
    return withGaps;
  }, [page, totalPages]);

  const btn = (active) =>
    `min-w-9 h-9 px-3 rounded-md text-sm transition-colors ${
      active
        ? "bg-primary text-primary-foreground"
        : "bg-secondary text-secondary-foreground hover:bg-primary/10"
    }`;

  return (
    <div className="flex items-center justify-center gap-1 mt-8">
      <button type="button" onClick={() => onChange(Math.max(1, page - 1))} disabled={page <= 1} className={`${btn(false)} disabled:opacity-40 disabled:cursor-not-allowed`} aria-label={__("Previous page")}>
        <ChevronLeftIcon className="w-4 h-4 inline" />
      </button>
      {pages.map((p, i) =>
        p === "…" ? (
          <span key={`gap-${i}`} className="px-2 text-muted-foreground">…</span>
        ) : (
          <button type="button" key={p} onClick={() => onChange(p)} className={btn(p === page)}>{p}</button>
        )
      )}
      <button type="button" onClick={() => onChange(Math.min(totalPages, page + 1))} disabled={page >= totalPages} className={`${btn(false)} disabled:opacity-40 disabled:cursor-not-allowed`} aria-label={__("Next page")}>
        <ChevronRightIcon className="w-4 h-4 inline" />
      </button>
    </div>
  );
}

function Collection({ data = {} }) {
  const entityName = data.options ? String(data.options).trim() : null;
  const Card = useMemo(() => lookupCard(entityName), [entityName]);
  const preloaded = data.preloaded;

  const {
    app: appOverride,
    page_size = 12,
    columns = 3,
    featured_only,
    exclude_featured,
    category,
    tag,
    title,
    description,
    card_variant = "default",
    hide_badges,
    detail_path,
    empty_message = `No items to show yet.`,
  } = data;

  const pageSize = Math.max(1, Math.min(48, parseInt(page_size, 10) || 12));
  const cols = Math.max(1, Math.min(4, parseInt(columns, 10) || 3));

  const [page, setPage] = useState(preloaded?.page || 1);
  const [items, setItems] = useState(preloaded?.items || []);
  const [totalPages, setTotalPages] = useState(preloaded?.total_pages || 1);
  const [loading, setLoading] = useState(!preloaded);
  const [refetching, setRefetching] = useState(false);
  const [error, setError] = useState(preloaded?.error || "");
  const consumedPreloadRef = useRef(false);
  const schemaFields = preloaded?.fields || [];

  const load = useCallback(async (asRefetch = false) => {
    if (!entityName) return;
    if (asRefetch) setRefetching(true);
    else setLoading(true);
    setError("");

    try {
      const query = {
        page: String(page),
        page_size: String(pageSize),
      };
      if (appOverride) query.app = String(appOverride).trim();
      if (featured_only) query.featured_only = "1";
      else if (exclude_featured) query.exclude_featured = "1";
      if (category) query.category = String(category).trim();
      if (tag) query.tag = String(tag).trim();

      const res = await loopar.call(entityName, "publicList", { query, freeze: false });
      setItems(Array.isArray(res?.items) ? res.items : []);
      setTotalPages(Math.max(1, parseInt(res?.total_pages, 10) || 1));
    } catch (e) {
      console.error(`Collection<${entityName}> load error:`, e);
      setError(e?.message || "Could not load items.");
      if (!asRefetch) setItems([]);
      setTotalPages(1);
    } finally {
      setLoading(false);
      setRefetching(false);
    }
  }, [entityName, appOverride, page, pageSize, featured_only, exclude_featured, category, tag]);

  useEffect(() => {
    if (!consumedPreloadRef.current) {
      consumedPreloadRef.current = true;
      if (preloaded && !preloaded.error && page === (preloaded.page || 1)) {
        return;
      }
      load(false);
      return;
    }
    load(true);
  }, [load]);

  if (!entityName) {
    return (
      <section className="w-full py-12 px-4 min-h-section-min">
        <div className="max-w-3xl mx-auto text-center text-sm text-muted-foreground">
          {__("Collection has no entity configured. Set the")} <code>options</code> {__("field.")}
        </div>
      </section>
    );
  }

  const gridCols = {
    1: "grid-cols-1",
    2: "grid-cols-1 sm:grid-cols-2",
    3: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3",
    4: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-4",
  }[cols];

  return (
    <section className={card_variant === "list" ? "w-full" : "w-full py-12 px-4 min-h-section-min"}>
      <div className={card_variant === "list" ? "flex flex-col gap-4" : "max-w-6xl mx-auto flex flex-col gap-8"}>
        {(title || description) && (
          <div className="text-center">
            {title && <h2 className="text-2xl md:text-3xl font-medium">{title}</h2>}
            {description && (
              <p className="text-sm text-muted-foreground mt-2 max-w-2xl mx-auto">
                {description}
              </p>
            )}
          </div>
        )}

        {loading ? (
          <Spinner />
        ) : error ? (
          <div className="text-sm text-destructive text-center py-8">{error}</div>
        ) : items.length === 0 ? (
          <div className="text-sm text-muted-foreground text-center py-12">
            {empty_message}
          </div>
        ) : (
          <>
            <div
              className={`${card_variant === "list" ? "flex flex-col" : `grid ${gridCols} gap-5`} transition-opacity duration-200 ${
                refetching ? "opacity-60 pointer-events-none" : "opacity-100"
              }`}
              aria-busy={refetching || undefined}
            >
              {items.map(item => (
                <Card
                  key={item.name}
                  item={item}
                  fields={schemaFields}
                  variant={card_variant}
                  detailPath={detail_path}
                  hideBadges={hide_badges === true || hide_badges === 1 || hide_badges === "1"}
                  collectionSlug={entityName}
                />
              ))}
            </div>
            <Pagination page={page} totalPages={totalPages} onChange={setPage} />
          </>
        )}
      </div>
    </section>
  );
}

Collection.metaFields = () => {
  return [
    {
      group: "custom",
      elements: {
        options: {
          ...entityPicker(),
          data: {
            ...entityPicker().data,
            label: "Entity",
            placeholder: "Project / Service / BlogPost",
            description: "The backing entity to list (must have a publicList action).",
          },
        },
        app: {
          element: INPUT,
          data: {
            label: "App",
            placeholder: "Leave empty to use current app",
          },
        },
        title: { element: TEXTAREA, data: { label: "Title" } },
        description: { element: TEXTAREA, data: { label: "Description" } },
        page_size: { element: INPUT, data: { label: "Items per page", format: "int" } },
        columns: { element: INPUT, data: { label: "Columns (1–4)", format: "int" } },
        featured_only: { element: SWITCH, data: { label: "Featured only" } },
        exclude_featured: { element: SWITCH, data: { label: "Exclude featured", description: "Hide featured items (e.g. when another collection on the page already shows them)." } },
        category: {
          element: INPUT,
          data: {
            label: "Filter by category",
            placeholder: "Leave empty for all",
          },
        },
        tag: {
          element: INPUT,
          data: {
            label: "Filter by tag",
            placeholder: "Leave empty for all tags",
          },
        },
        card_variant: {
          element: SELECT,
          data: {
            label: "Card variant",
            options: "default\ncompact\noverlay\nlist",
            description: "Overlay: the cover fills the card with the title and summary on top.",
          },
        },
        detail_path: {
          element: INPUT,
          data: {
            label: "Detail page",
            placeholder: "/services",
            description: "Page that shows the item detail (the one holding the full collection). Set it when this collection sits on another page, such as the home.",
          },
        },
        hide_badges: {
          element: SWITCH,
          data: { label: "Hide badges", description: "Don't show the Featured badge (and other switch badges) on the cards." },
        },
        empty_message: {
          element: TEXTAREA,
          data: { label: "Empty state message" },
        },
      },
    },
  ];
};

export default withRoot(Collection);
