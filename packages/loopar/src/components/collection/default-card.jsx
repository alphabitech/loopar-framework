import { useMemo } from "react";
import fileManager from "@@file/file-manager";
import {Link} from "@link";
import { __ } from "@global/i18n";
import { formatDate } from "@global/format";

export default function DefaultCard({ item, fields = [], variant = "default", collectionSlug, hideBadges = false, detailPath }) {
  const fieldsByName = useMemo(() => {
    const map = {};
    for (const f of (fields || [])) map[f.name] = f;
    return map;
  }, [fields]);

  const cover = useMemo(() => {
    const candidates = [];
    if (fieldsByName.cover_image) candidates.push("cover_image");
    for (const f of fields) {
      if (f.element === "image_input" && !f.multiple && !candidates.includes(f.name)) {
        candidates.push(f.name);
      }
    }
    for (const name of candidates) {
      const raw = item?.[name];
      if (!raw) continue;
      const mapped = fileManager.getMappedFiles(raw) || [];
      const hit = mapped.find(x => x && x.src);
      if (hit) return hit;
    }
    return null;
  }, [item, fields, fieldsByName]);

  const title = item?.title
    ?? item?.[fieldsByName.title?.name || ""]
    ?? item?.[firstField(fields, f => f.element === "input")?.name || ""]
    ?? item?.name
    ?? "Untitled";

  const summary = item?.summary
    ?? item?.[firstField(fields, f => f.element === "textarea")?.name || ""]
    ?? null;

  const tags = Array.isArray(item?.tags) ? item.tags.slice(0, 3) : [];

  const dateField = firstField(fields, f => f.element === "date" || f.element === "date_time");
  const dateValue = dateField ? item?.[dateField.name] : null;
  const dateLabel = dateValue
    ? formatDate(dateValue, { month: "short", year: "numeric" })
    : null;

  const badges = useMemo(() => {
    const out = [];
    if (hideBadges) return out;
    if (item?.featured) out.push("Featured");
    for (const f of fields) {
      if (f.element !== "switch" || !f.show_in_card) continue;
      if (f.name === "featured") continue; // already covered
      if (item?.[f.name]) out.push(f.label || f.name);
    }
    return out;
  }, [item, fields, hideBadges]);

  const to = item?.custom_url
    ? String(item.custom_url).trim()
    : (item?.slug || item?.name || "");
  const isExternal = /^https?:\/\//i.test(to);
  // Detail lives on the page holding the collection; `detailPath` points the
  // cards of a collection placed elsewhere (e.g. the home) to that page.
  const detailBase = String(detailPath || "").trim().replace(/\/+$/, "");
  const detailQuery = `collection?collection=${collectionSlug}&detailSlug=${item?.slug}`;
  const detailTo = detailBase
    ? `${detailBase.startsWith("/") ? "" : "/"}${detailBase}/${detailQuery}`
    : detailQuery;

  if (variant === "list") {
    const minutes = parseInt(item?.reading_time, 10);
    return (
      <Link
        to={isExternal ? to : detailTo}
        bare
        notControlled={isExternal}
        _target={isExternal ? "_blank" : undefined}
        rel={isExternal ? "noopener noreferrer" : undefined}
        className="group grid grid-cols-1 sm:grid-cols-[6rem_1fr_auto] gap-1 sm:gap-4 items-baseline py-5 border-t border-border last:border-b"
      >
        <span className="font-mono text-xs text-muted-foreground whitespace-nowrap">
          {dateValue ? formatDate(dateValue, "medium") : ""}
        </span>
        <span className="flex flex-col gap-1 min-w-0">
          <span className="text-base md:text-lg font-medium leading-snug group-hover:text-primary transition-colors">
            {title}
          </span>
          {summary ? (
            <span className="text-sm text-muted-foreground leading-relaxed line-clamp-2">{summary}</span>
          ) : null}
          {minutes > 0 ? (
            <span className="text-xs text-muted-foreground">{__("{0} min read", [minutes])}</span>
          ) : null}
        </span>
        <span className="hidden sm:inline text-primary transition-transform group-hover:translate-x-1" aria-hidden="true">→</span>
      </Link>
    );
  }

  // "overlay": the cover fills the card and the title/summary sit on a dark
  // gradient, so the text is always light regardless of the theme.
  if (variant === "overlay") {
    return (
      <Link
        to={detailTo}
        bare
        notControlled={isExternal}
        _target={isExternal ? "_blank" : undefined}
        rel={isExternal ? "noopener noreferrer" : undefined}
        className="group relative flex h-full min-h-80 flex-col justify-end overflow-hidden rounded-2xl border-2 border-border/70 bg-secondary shadow-md transition-all duration-300 hover:-translate-y-1 hover:border-primary/40 hover:shadow-2xl"
      >
        {cover ? (
          <img
            src={cover.src}
            alt=""
            loading="lazy"
            className="absolute inset-0 h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
          />
        ) : null}
        <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/45 to-black/10" aria-hidden="true" />
        <div className="relative flex flex-col gap-2 p-6">
          <h3 className="text-xl font-bold leading-tight tracking-tight !text-white drop-shadow-sm">{title}</h3>
          {summary ? <p className="text-sm leading-relaxed !text-white/85 line-clamp-3">{summary}</p> : null}
        </div>
      </Link>
    );
  }

  return (
    <Link
      to={detailTo}
      bare
      notControlled={isExternal}
      _target={isExternal ? "_blank" : undefined}
      rel={isExternal ? "noopener noreferrer" : undefined}
      className="group bg-card text-card-foreground border rounded-xl overflow-hidden flex flex-col hover:shadow-lg transition-shadow"
    >
      <div className={`relative bg-secondary overflow-hidden ${
        variant === "compact" ? "aspect-[16/10]" : "aspect-[4/3]"
      }`}>
        {cover ? (
          <img
            src={cover.src}
            alt={cover.name || title}
            loading="lazy"
            className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-muted-foreground text-xs opacity-60">
            {__("No cover")}
          </div>
        )}
        {badges.length > 0 ? (
          <div className="absolute top-2 left-2 flex gap-1 flex-wrap">
            {badges.map(b => (
              <span key={b} className="text-[10px] font-medium uppercase tracking-wide px-2 py-0.5 rounded-md bg-primary text-primary-foreground">
                {b}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      <div className="p-4 flex flex-col gap-2 flex-1">
        <div className="flex items-start justify-between gap-3">
          <h3 className="text-base font-medium leading-tight line-clamp-2">
            {title}
          </h3>
          {dateLabel ? (
            <span className="text-xs text-muted-foreground whitespace-nowrap mt-0.5">
              {dateLabel}
            </span>
          ) : null}
        </div>

        {summary ? (
          <p className="text-sm text-muted-foreground leading-relaxed line-clamp-3">
            {summary}
          </p>
        ) : null}

        {tags.length > 0 ? (
          <div className="flex flex-wrap gap-1.5 mt-auto pt-2">
            {tags.map(t => (
              <span
                key={t}
                className="text-xs px-2 py-0.5 rounded-md bg-secondary/60 text-secondary-foreground"
              >
                #{t}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </Link>
  );
}

function firstField(fields, predicate) {
  for (const f of (fields || [])) {
    if (predicate(f)) return f;
  }
  return null;
}
