import { useState, useEffect, useCallback, useMemo } from "react";
import { loopar } from "loopar";
import fileManager from "@@file/file-manager";
import { ArrowLeftIcon, Loader2, ExternalLinkIcon } from "lucide-react";
import ImageCarousel from "./image-carousel.jsx";
import ImageGrid from "./image-grid.jsx";
import { Preview as MarkdownPreview } from "../markdown/preview.jsx";
import DocumentHistory from "../document-history.jsx";
import { __ } from "@global/i18n";
import { formatDate, formatNumber } from "@global/format";

function CommentsBlock({ entity, item }) {
  if (!entity || !item?.name) return null;
  return (
    <section className="border-t pt-10">
      <DocumentHistory
        document={entity}
        documentName={item.name}
        enableComments
        historyApi={{ entity, action: "comments" }}
        title={__("Comments")}
        className="border-0 bg-transparent"
        emptyMessage={__("No comments yet. Be the first.")}
      />
    </section>
  );
}

const SKIP_FIELDS = new Set([
  "slug", "name", "app", "published",
  "tags", "custom_url",
  "cover_image", "images",
  "title", "summary", "description",
  "parent_id", "parent_document",
]);

function isMetadataField(f) {
  if (f.element === "_section") return false;
  if (f.element === "image_input") return false;
  if (f.element === "markdown_input") return false;
  if (f.element === "textarea") return false;
  if (f.hidden) return false;
  if (SKIP_FIELDS.has(f.name)) return false;
  return true;
}

function Loading() {
  return (
    <article className="w-full min-h-section-min flex items-center justify-center" aria-busy="true" aria-live="polite">
      <Loader2 className="w-6 h-6 animate-spin text-muted-foreground opacity-70" />
    </article>
  );
}

function formatValue(field, value) {
  if (value == null || value === "") return null;
  if (field.element === "date" || field.element === "date_time") {
    return formatDate(value, "long");
  }
  if (field.element === "switch" || field.element === "checkbox") {
    return value ? __(field.label || "Yes") : null;
  }
  if (field.format === "decimal" || field.format === "int" || field.format === "integer") {
    const n = Number(value);
    if (Number.isNaN(n)) return String(value);
    return formatNumber(n, { maximumFractionDigits: Number.isInteger(n) ? 0 : 2 });
  }
  return String(value);
}

function firstField(fields, predicate) {
  for (const f of (fields || [])) {
    if (predicate(f)) return f;
  }
  return null;
}

export default function DefaultDetail(props) {
  const {
    slug, app, entity, fields = [],
    preloadedItem = null,
    onBack = null,
    backHref = ".", backLabel = "Back",
    showBack = true,
    notFoundMessage = "Not found, or no longer published.",
    layout = "page",
    galleryMode = "carousel",
    galleryColumns = 3,
    enableComments = false,
  } = props;

  const [item, setItem] = useState(preloadedItem);
  const [loading, setLoading] = useState(!preloadedItem && !!slug);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!slug || !entity) { setItem(null); setLoading(false); return; }
    setLoading(true);
    setError("");
    try {
      const query = { slug };
      if (app) query.app = String(app).trim();
      const res = await loopar.call(entity, "publicView", { query, freeze: false });
      setItem(res && res.name ? res : null);
    } catch (e) {
      console.error(`DefaultDetail<${entity}> load error:`, e);
      setError(e?.message || "Could not load item.");
      setItem(null);
    } finally {
      setLoading(false);
    }
  }, [slug, app, entity]);

  useEffect(() => {
    if (preloadedItem) { setItem(preloadedItem); setLoading(false); return; }
    load();
  }, [preloadedItem, load]);

  const handleBack = (e) => {
    if (onBack) { onBack(backHref, e); return; }
    if (typeof window !== "undefined" && backHref && !/^https?:\/\//i.test(backHref)) {
      e.preventDefault();
      window.history.pushState({}, "", backHref === "." ? window.location.pathname : backHref);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
  };

  if (loading) return <Loading />;
  if (error) {
    return (
      <article className="w-full min-h-section-min">
        <div className="max-w-3xl mx-auto px-4 py-16 text-center">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      </article>
    );
  }
  if (!item) {
    return (
      <article className="w-full min-h-section-min">
        <div className="max-w-3xl mx-auto px-4 py-16 text-center flex flex-col gap-4 items-center">
          <p className="text-sm text-muted-foreground">{notFoundMessage}</p>
          {showBack ? (
            <a href={backHref} onClick={handleBack} className="inline-flex items-center gap-2 text-sm text-primary hover:underline">
              <ArrowLeftIcon className="w-4 h-4" />
              {backLabel}
            </a>
          ) : null}
        </div>
      </article>
    );
  }

  const shared = { item, fields, entity, enableComments, backHref, backLabel, showBack, handleBack, galleryMode, galleryColumns };
  if (layout === "gallery") return <DetailGallery {...shared} />;
  if (layout === "article") return <DetailArticle {...shared} />;
  return <DetailPage {...shared} />;
}

const WORDS_PER_MINUTE = 220;

function readingMinutes(item, descField) {
  const stored = parseInt(item.reading_time, 10);
  if (stored > 0) return stored;
  const text = descField ? String(item[descField.name] || "") : "";
  const words = text.split(/\s+/).filter(Boolean).length;
  return words ? Math.max(1, Math.round(words / WORDS_PER_MINUTE)) : null;
}

function DetailArticle({ item, fields, entity, enableComments, backHref, backLabel, showBack, handleBack }) {
  const coverField = useMemo(() => firstField(fields, f => f.element === "image_input" && !f.multiple), [fields]);
  const dateField = useMemo(() => firstField(fields, f => f.element === "date" || f.element === "date_time"), [fields]);
  const descField = useMemo(() =>
    firstField(fields, f => f.element === "markdown_input" && f.name === "description")
    || firstField(fields, f => f.element === "markdown_input"),
  [fields]);

  const cover = useMemo(() => {
    if (!coverField) return null;
    const mapped = fileManager.getMappedFiles(item[coverField.name]) || [];
    return mapped.find(f => f && f.src) || null;
  }, [item, coverField]);

  const date = formatDate(dateField ? item[dateField.name] : item.__created_at__, "long");
  const minutes = readingMinutes(item, descField);
  const tags = Array.isArray(item.tags) ? item.tags : [];
  const meta = [item.author, date, minutes ? `${minutes} min read` : null].filter(Boolean);

  return (
    <article className="w-full animate-fade-in-up">
      <header className="max-w-3xl mx-auto px-4 sm:px-6 pt-12 md:pt-16 pb-8 flex flex-col gap-4">
        {showBack ? (
          <a href={backHref} onClick={handleBack} className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors w-fit">
            <ArrowLeftIcon className="w-4 h-4" />
            {backLabel}
          </a>
        ) : null}
        {meta.length > 0 ? (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs uppercase tracking-wide text-muted-foreground">
            <span className="w-3 h-px bg-primary" />
            {meta.map((m, i) => (
              <span key={i} className="inline-flex items-center gap-2">
                {i > 0 ? <span aria-hidden="true">·</span> : null}
                {m}
              </span>
            ))}
          </div>
        ) : null}
        <h1 className="text-3xl md:text-5xl font-semibold leading-tight tracking-tight">
          {item.title || item.name}
        </h1>
        {item.summary ? (
          <p className="text-lg md:text-xl text-muted-foreground leading-relaxed">{item.summary}</p>
        ) : null}
        {tags.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {tags.map(t => (
              <span key={t} className="text-xs px-2 py-0.5 rounded-md bg-secondary text-secondary-foreground">#{t}</span>
            ))}
          </div>
        ) : null}
      </header>

      {cover ? (
        <div className="max-w-5xl mx-auto px-4 sm:px-6">
          <div className="aspect-[16/9] w-full overflow-hidden rounded-2xl bg-secondary border">
            <img src={cover.src} alt={cover.name || item.title} loading="eager" className="w-full h-full object-cover" />
          </div>
        </div>
      ) : null}

      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-10 md:py-14 flex flex-col gap-12">
        {descField && item[descField.name] ? (
          <div className="prose-container">
            <MarkdownPreview source={item[descField.name]} />
          </div>
        ) : null}

        {enableComments ? <CommentsBlock entity={entity} item={item} /> : null}
      </div>
    </article>
  );
}

function DetailPage({ item, fields, entity, enableComments, backHref, backLabel, showBack, handleBack, galleryMode = "carousel", galleryColumns = 3 }) {
  const coverField = useMemo(() => firstField(fields, f => f.element === "image_input" && !f.multiple), [fields]);
  const galleryField = useMemo(() => firstField(fields, f => f.element === "image_input" && f.multiple), [fields]);
  const descField = useMemo(() =>
    firstField(fields, f => f.element === "markdown_input" && f.name === "description")
    || firstField(fields, f => f.element === "markdown_input"),
  [fields]);

  const cover = useMemo(() => {
    if (!coverField) return null;
    const mapped = fileManager.getMappedFiles(item[coverField.name]) || [];
    return mapped.find(f => f && f.src) || null;
  }, [item, coverField]);

  const kicker = item.category || null;
  const tags = Array.isArray(item.tags) ? item.tags : [];

  const metadataRows = useMemo(() => {
    return fields.filter(f => {
      if (!isMetadataField(f)) return false;
      const v = item[f.name];
      if (v == null || v === "") return false;
      return true;
    });
  }, [fields, item]);

  return (
    <article className="w-full animate-fade-in-up">
      {cover ? (
        <header className="relative w-full bg-secondary overflow-hidden">
          <div className="aspect-[21/9] md:aspect-[21/8] w-full">
            <img
              src={cover.src}
              alt={cover.name || item.title}
              loading="eager"
              className="w-full h-full object-cover"
            />
          </div>
          <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-black/10 to-transparent pointer-events-none" />
          <div className="absolute inset-0 flex items-end">
            <div className="max-w-6xl mx-auto w-full px-4 sm:px-6 lg:px-8 pb-8 md:pb-12">
              {showBack ? (
                <a
                  href={backHref}
                  onClick={handleBack}
                  className="inline-flex items-center gap-2 text-sm text-white/80 hover:text-white transition-colors mb-3"
                >
                  <ArrowLeftIcon className="w-4 h-4" />
                  {backLabel}
                </a>
              ) : null}
              <h1 className="text-3xl md:text-5xl lg:text-6xl font-medium text-white leading-tight">
                {item.title || item.name}
              </h1>
            </div>
          </div>
        </header>
      ) : (
        <header className="w-full bg-secondary/30 py-12">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
            {showBack ? (
              <a href={backHref} onClick={handleBack} className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors mb-3">
                <ArrowLeftIcon className="w-4 h-4" />
                {backLabel}
              </a>
            ) : null}
            <h1 className="text-3xl md:text-5xl font-medium leading-tight">
              {item.title || item.name}
            </h1>
          </div>
        </header>
      )}

      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-12 md:py-16 flex flex-col gap-12 md:gap-16">
        {(kicker || item.summary || (descField && item[descField.name])) ? (
          <section className="grid grid-cols-1 md:grid-cols-2 gap-8 md:gap-12">
            <div className="flex flex-col gap-4">
              {kicker ? (
                <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
                  <span className="w-3 h-px bg-primary" />
                  {kicker}
                </div>
              ) : null}
              {item.summary ? (
                <h2 className="text-2xl md:text-3xl font-medium leading-tight">
                  {item.summary}
                </h2>
              ) : null}
              {tags.length > 0 ? (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {tags.map(t => (
                    <span key={t} className="text-xs px-2 py-0.5 rounded-md bg-secondary text-secondary-foreground">
                      #{t}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
            {descField && item[descField.name] ? (
              <div className="prose-container">
                <MarkdownPreview source={item[descField.name]} />
              </div>
            ) : null}
          </section>
        ) : null}

        {metadataRows.length > 0 ? (
          <section className="border-t border-b py-6 grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-3">
            {metadataRows.map(f => {
              const v = item[f.name];
              const display = formatValue(f, v);
              if (!display) return null;
              const isUrl = typeof v === "string" && /^https?:\/\//i.test(v);
              return (
                <div key={f.name} className="flex items-baseline justify-between gap-4 border-b last:border-b-0 md:border-b-0 py-2 md:py-1">
                  <span className="text-xs uppercase tracking-wide text-muted-foreground shrink-0">
                    {f.label || f.name}
                  </span>
                  {isUrl ? (
                    <a
                      href={v}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm text-primary hover:underline inline-flex items-center gap-1.5"
                    >
                      {display}
                      <ExternalLinkIcon className="w-3 h-3 opacity-70" />
                    </a>
                  ) : (
                    <span className="text-sm text-right">{display}</span>
                  )}
                </div>
              );
            })}
          </section>
        ) : null}

        {galleryField && item[galleryField.name] ? (
          <section>
            {galleryMode === "grid" ? (
              <ImageGrid
                images={item[galleryField.name]}
                columns={galleryColumns}
                aspect="aspect-[4/3]"
              />
            ) : (
              <ImageCarousel
                images={item[galleryField.name]}
                aspect="aspect-[16/9]"
                showThumbs={true}
                showCounter={true}
                autoplay={false}
              />
            )}
          </section>
        ) : null}

        {enableComments ? (
          <div className="max-w-3xl w-full">
            <CommentsBlock entity={entity} item={item} />
          </div>
        ) : null}

      </div>
    </article>
  );
}

function DetailGallery({ item, fields, entity, enableComments, backHref, backLabel, showBack, handleBack }) {
  const coverField = useMemo(() => firstField(fields, f => f.element === "image_input" && !f.multiple), [fields]);
  const galleryField = useMemo(() => firstField(fields, f => f.element === "image_input" && f.multiple), [fields]);
  const descField = useMemo(() =>
    firstField(fields, f => f.element === "markdown_input" && f.name === "description")
    || firstField(fields, f => f.element === "markdown_input"),
  [fields]);

  const tags = Array.isArray(item.tags) ? item.tags : [];

  const sections = useMemo(() => {
    const out = [];
    let current = { title: null, fields: [] };
    for (const f of fields) {
      if (f.element === "_section") {
        if (current.fields.length) out.push(current);
        current = { title: f.label, fields: [] };
        continue;
      }
      if (f.element === "image_input") continue;
      if (f.element === "markdown_input" && f.name === (descField?.name || "")) continue;
      if (f.hidden) continue;
      if (SKIP_FIELDS.has(f.name)) continue;
      if (item[f.name] == null || item[f.name] === "") continue;
      current.fields.push(f);
    }
    if (current.fields.length) out.push(current);
    return out;
  }, [fields, item, descField]);

  return (
    <article className="w-full min-h-section-min animate-fade-in-up">
      <div className="max-w-5xl mx-auto px-4 py-12 flex flex-col gap-10">
        {showBack ? (
          <a href={backHref} onClick={handleBack} className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors w-fit">
            <ArrowLeftIcon className="w-4 h-4" />
            {backLabel}
          </a>
        ) : null}

        <header className="grid grid-cols-1 md:grid-cols-[1.2fr_1fr] gap-8 items-start">
          {galleryField || coverField ? (
            <div>
              <ImageCarousel
                images={
                  galleryField && item[galleryField.name]?.length
                    ? item[galleryField.name]
                    : (coverField ? item[coverField.name] : null)
                }
                aspect="aspect-[16/10]"
                showThumbs={true}
                showCounter={true}
                autoplay={false}
              />
            </div>
          ) : <div />}

          <div className="flex flex-col gap-4">
            {item.featured ? (
              <span className="text-[10px] font-medium uppercase tracking-wide px-2 py-0.5 rounded-md bg-primary text-primary-foreground w-fit">
                {__("Featured")}
              </span>
            ) : null}
            <h1 className="text-3xl md:text-4xl font-medium leading-tight">
              {item.title || item.name}
            </h1>
            {item.summary ? (
              <p className="text-base text-muted-foreground leading-relaxed">
                {item.summary}
              </p>
            ) : null}
            {tags.length > 0 ? (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {tags.map(t => (
                  <span key={t} className="text-xs px-2 py-0.5 rounded-md bg-secondary text-secondary-foreground">
                    #{t}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        </header>

        {descField && item[descField.name] ? (
          <section className="prose-container">
            <MarkdownPreview source={item[descField.name]} />
          </section>
        ) : null}

        {sections.map((sec, i) => (
          <section key={i} className="flex flex-col gap-4">
            {sec.title ? <h2 className="text-lg font-medium border-b pb-2">{sec.title}</h2> : null}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {sec.fields.map(f => {
                const display = formatValue(f, item[f.name]);
                if (!display) return null;
                return (
                  <div key={f.name} className="flex items-center gap-2 text-sm">
                    <span className="text-muted-foreground">{f.label || f.name}:</span>
                    <span>{display}</span>
                  </div>
                );
              })}
            </div>
          </section>
        ))}

        {enableComments ? <CommentsBlock entity={entity} item={item} /> : null}
      </div>
    </article>
  );
}
