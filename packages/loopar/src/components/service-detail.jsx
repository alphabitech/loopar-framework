import { useEffect, useMemo, useState } from "react";
import { loopar } from "loopar";
import fileManager from "@@file/file-manager";
import { ArrowLeftIcon, Loader2 } from "lucide-react";
import { Preview as MarkdownPreview } from "./markdown/preview.jsx";

/**
 * Detail of a Service: what it is (summary, description), what it includes
 * and what it doesn't, and the service's own calls to action. Internal
 * fields (order, pricing model, icon…) are not shown.
 */
export default function ServiceDetail({ slug, app, entity, preloadedItem = null, backHref = ".", backLabel = "Back", onBack, notFoundMessage = "This service is not available." }) {
  const [item, setItem] = useState(preloadedItem);
  const [loading, setLoading] = useState(!preloadedItem && !!slug);

  useEffect(() => {
    if (preloadedItem) { setItem(preloadedItem); setLoading(false); return; }
    if (!slug || !entity) { setLoading(false); return; }
    const query = { slug, ...(app ? { app: String(app).trim() } : {}) };
    loopar.call(entity, "publicView", { query, freeze: false })
      .then((res) => setItem(res?.name ? res : null))
      .catch(() => setItem(null))
      .finally(() => setLoading(false));
  }, [preloadedItem, slug, app, entity]);

  const cover = useMemo(() => {
    if (!item?.cover_image) return null;
    return (fileManager.getMappedFiles(item.cover_image) || []).find((f) => f?.src) || null;
  }, [item]);

  if (loading) {
    return (
      <article className="w-full min-h-section-min flex items-center justify-center" aria-busy="true">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground opacity-70" />
      </article>
    );
  }

  if (!item) {
    return (
      <article className="w-full min-h-section-min">
        <p className="max-w-3xl mx-auto px-4 py-16 text-center text-sm text-muted-foreground">{notFoundMessage}</p>
      </article>
    );
  }

  const back = (e) => { if (onBack) onBack(backHref, e); };
  const ctas = [
    item.cta_label && item.cta_url ? { label: item.cta_label, url: item.cta_url, primary: true } : null,
    item.cta_secondary_label && item.cta_secondary_url ? { label: item.cta_secondary_label, url: item.cta_secondary_url } : null,
  ].filter(Boolean);

  return (
    <article className="w-full animate-fade-in-up">
      <header className="relative w-full overflow-hidden bg-primary text-primary-foreground">
        {cover ? (
          <img src={cover.src} alt="" loading="eager" className="absolute inset-0 w-full h-full object-cover opacity-25" />
        ) : null}
        <div className="relative max-w-5xl mx-auto px-4 sm:px-6 py-14 md:py-20 flex flex-col gap-4">
          <a href={backHref} onClick={back} className="inline-flex items-center gap-2 text-sm opacity-80 hover:opacity-100 w-fit">
            <ArrowLeftIcon className="w-4 h-4" /> {backLabel}
          </a>
          {item.category ? <p className="text-xs uppercase tracking-wider opacity-80">{item.category}</p> : null}
          <h1 className="text-3xl md:text-5xl font-semibold leading-tight text-inherit">{item.title}</h1>
          {item.summary ? <p className="text-lg md:text-xl max-w-3xl opacity-90">{item.summary}</p> : null}
        </div>
      </header>

      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-12 md:py-16 flex flex-col gap-10">
        {item.description ? (
          <section className="prose-container max-w-3xl">
            <MarkdownPreview source={item.description} />
          </section>
        ) : null}

        {(item.deliverables || item.not_included) ? (
          <section className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {item.deliverables ? (
              <div className="rounded-xl border bg-card p-6">
                <h2 className="text-lg font-semibold mb-3">What it can include</h2>
                <MarkdownPreview source={item.deliverables} />
              </div>
            ) : null}
            {item.not_included ? (
              <div className="rounded-xl border bg-card p-6">
                <h2 className="text-lg font-semibold mb-3">Good to know</h2>
                <MarkdownPreview source={item.not_included} />
              </div>
            ) : null}
          </section>
        ) : null}

        {ctas.length ? (
          <div className="flex flex-wrap gap-3">
            {ctas.map((c) => (
              <a
                key={c.url}
                href={c.url}
                className={c.primary
                  ? "inline-flex items-center rounded-lg bg-primary text-primary-foreground px-6 py-3 font-semibold"
                  : "inline-flex items-center rounded-lg border border-primary text-primary px-6 py-3 font-semibold"}
              >
                {c.label}
              </a>
            ))}
          </div>
        ) : null}
      </div>
    </article>
  );
}
