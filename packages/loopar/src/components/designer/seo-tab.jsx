import { useMemo, useState } from "react";
import { useDocument } from "@loopar/document";
import { __ } from "@global/i18n";
import { cn } from "@cn/lib/utils";
import { Input } from "@cn/components/ui/input";
import { Textarea } from "@cn/components/ui/textarea";
import { Switch } from "@cn/components/ui/switch";
import { parsePageSeo, SEO_LIMITS } from "@global/page-seo";

/** True when the document being designed has an `seo` field (website pages). */
export function useHasSeo() {
  const { Document, docRef } = useDocument();
  return useMemo(
    () => !!docRef?.setValue && String(Document?.Entity?.doc_structure || "").includes('"name":"seo"'),
    [Document?.Entity?.doc_structure, docRef]
  );
}

function Field({ label, hint, count, limit, children }) {
  const over = limit && count > limit;
  return (
    <label className="flex flex-col gap-1.5">
      <span className="flex items-baseline justify-between gap-3 text-sm font-medium">
        {label}
        {limit ? (
          <span className={cn("text-xs font-normal tabular-nums", over ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground")}>
            {count}/{limit}
          </span>
        ) : null}
      </span>
      {children}
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

/** How the page reads in a search result. */
function SearchPreview({ title, description, path }) {
  const host = typeof window !== "undefined" ? window.location.host : "";
  return (
    <div className="rounded-lg border bg-card p-4">
      <p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">{__("Search result preview")}</p>
      <p className="truncate text-xs text-muted-foreground">{host}{path ? ` › ${path}` : ""}</p>
      <p className="truncate text-lg leading-snug text-blue-700 dark:text-blue-400">{title || __("Page title")}</p>
      <p className="line-clamp-2 text-sm text-muted-foreground">
        {description || __("Without a description, search engines pick a fragment of the page.")}
      </p>
    </div>
  );
}

/**
 * The designer's "SEO" tab: what search engines and social networks read of
 * the page (title, description, share image, indexing), stored in the
 * document's `seo` field and rendered as head tags — not as canvas elements.
 * Its texts are translated in the "Translations" tab with the rest of the page.
 */
export function SeoTab() {
  const { docRef, name } = useDocument();
  const [, refresh] = useState(0);

  // Read on every render: undo/redo and other tabs may have changed it meanwhile.
  const seo = parsePageSeo(docRef?.getValue?.("seo"));
  // Stored as typed (the server trims and drops empty fields on save).
  const set = (field, value) => {
    docRef.setValue("seo", JSON.stringify({ ...seo, [field]: value }));
    refresh((n) => n + 1);
  };
  const text = (field) => String(seo[field] ?? "");
  const noindex = [1, "1", true, "true"].includes(seo.noindex);

  return (
    <div className="grid gap-6 p-1 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <div className="flex flex-col gap-5">
        <Field label={__("Title")} count={text("title").length} limit={SEO_LIMITS.title}
          hint={__("Shown in the browser tab and as the headline of the search result.")}>
          <Input value={text("title")} onChange={(e) => set("title", e.target.value)} />
        </Field>

        <Field label={__("Description")} count={text("description").length} limit={SEO_LIMITS.description}
          hint={__("One or two sentences that say what the page offers.")}>
          <Textarea rows={3} value={text("description")} onChange={(e) => set("description", e.target.value)} />
        </Field>

        <Field label={__("Share image")}
          hint={__("Image shown when the page is shared (URL or site path). 1200×630 works everywhere.")}>
          <Input value={text("image")} placeholder="/assets/public/share.jpg" onChange={(e) => set("image", e.target.value)} />
        </Field>

        <details className="rounded-lg border p-4">
          <summary className="cursor-pointer text-sm font-medium">{__("Social networks and advanced")}</summary>
          <div className="mt-4 flex flex-col gap-5">
            <Field label={__("Social title")} hint={__("Leave empty to use the title.")}>
              <Input value={text("og_title")} placeholder={text("title")} onChange={(e) => set("og_title", e.target.value)} />
            </Field>
            <Field label={__("Social description")} hint={__("Leave empty to use the description.")}>
              <Textarea rows={2} value={text("og_description")} placeholder={text("description")} onChange={(e) => set("og_description", e.target.value)} />
            </Field>
            <Field label={__("Additional head tags")}
              hint={__("One per line: meta | name=keywords | content=a, b")}>
              <Textarea rows={3} className="font-mono text-xs" value={text("extra")} onChange={(e) => set("extra", e.target.value)} />
            </Field>
          </div>
        </details>

        <label className="flex items-start gap-3">
          <Switch checked={noindex} onCheckedChange={(on) => set("noindex", on ? 1 : 0)} />
          <span className="flex flex-col">
            <span className="text-sm font-medium">{__("Hide this page from search engines")}</span>
            <span className="text-xs text-muted-foreground">{__("The page stays online; it is only left out of search results.")}</span>
          </span>
        </label>
      </div>

      <div className="flex flex-col gap-4">
        <SearchPreview title={text("title")} description={text("description")} path={name} />
        <p className="text-xs text-muted-foreground">
          {__("The canonical address, the language tags and the site's structured data are added automatically.")}
        </p>
      </div>
    </div>
  );
}
