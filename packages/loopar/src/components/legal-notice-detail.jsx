import { useEffect, useState } from "react";
import { loopar } from "loopar";
import { Loader2 } from "lucide-react";
import { Preview as MarkdownPreview } from "./markdown/preview.jsx";

function fmtDate(value) {
  if (!value) return null;
  const date = new Date(`${String(value).slice(0, 10)}T12:00:00`);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString("en-US", { day: "numeric", month: "long", year: "numeric" });
}

/**
 * Detail of a Legal Notice (Privacy Notice, Terms of Use…): a single reading
 * column with its dates, as legal texts are read, not browsed.
 */
export default function LegalNoticeDetail({ slug, app, entity, preloadedItem = null, notFoundMessage = "This notice is not available." }) {
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

  const dates = [
    item.effective_date ? `Effective ${fmtDate(item.effective_date)}` : null,
    item.last_updated ? `Last updated ${fmtDate(item.last_updated)}` : null,
  ].filter(Boolean);

  return (
    <article className="w-full animate-fade-in-up">
      <header className="max-w-3xl mx-auto px-4 sm:px-6 pt-12 md:pt-16 pb-6 flex flex-col gap-3 border-b">
        <h1 className="text-3xl md:text-4xl font-semibold leading-tight tracking-tight">{item.title}</h1>
        {dates.length > 0 ? (
          <p className="text-sm text-muted-foreground">{dates.join(" · ")}</p>
        ) : null}
        {item.summary ? <p className="text-lg text-muted-foreground leading-relaxed">{item.summary}</p> : null}
      </header>
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-10 md:py-12">
        {item.description ? (
          <div className="prose-container">
            <MarkdownPreview source={item.description} />
          </div>
        ) : null}
      </div>
    </article>
  );
}
