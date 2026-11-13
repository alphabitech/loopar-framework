import { useMemo, useState } from "react";
import { useDocument } from "@loopar/document";
import { useWorkspace } from "@workspace/workspace-provider";
import { __, currentLanguage } from "@global/i18n";
import {
  TranslationsPanel, WEBSITE_BUILDERS, translationTargets, layoutTexts, panelLanguages, NoLanguages,
} from "../translation/translations-panel";
import { seoTexts } from "@global/page-seo";

/** True when the document being designed has a `translations` field to keep the layout's translations. */
export function useHasTranslations() {
  const { Document, docRef } = useDocument();
  return useMemo(
    () => !!docRef?.setValue && String(Document?.Entity?.doc_structure || "").includes('"name":"translations"'),
    [Document?.Entity?.doc_structure, docRef]
  );
}

/**
 * The designer's "Translations" tab: every text of the layout being
 * designed next to its translation, stored in the document's
 * `translations` field (by node key and prop) — the same storage the
 * element editor's "Languages" modal writes.
 *   - Website layouts (Page Builder, Contact Form Builder): the page in
 *     the site's other languages.
 *   - Desk layouts (Entity, Form Builder…): overrides of the dictionary for
 *     these elements; the dictionary translation shows as the hint.
 */
export function TranslationsTab({ metaComponents }) {
  const { Document, docRef } = useDocument();
  const { __META__ } = useWorkspace();
  const [, refresh] = useState(0);

  const website = WEBSITE_BUILDERS.has(Document?.Entity?.name);
  const { base, languages } = translationTargets(__META__, website);
  // A page's search/social texts (its `seo` field) are translated with its layout.
  const seo = docRef?.getValue?.("seo") ?? "";
  const texts = useMemo(() => [...seoTexts(seo), ...layoutTexts(metaComponents)], [metaComponents, seo]);

  // Read on every render: the "Languages" modal may have changed it meanwhile.
  const value = docRef?.getValue?.("translations") ?? "";
  const all = panelLanguages(value, base, languages);

  if (!all.length) return <NoLanguages website={website} />;

  const hintFor = website ? null : (t, language) => {
    if (language !== currentLanguage()) return null;
    const hint = __(t.value);
    return hint !== t.value ? hint : null;
  };

  return (
    <div className="p-1">
      <TranslationsPanel
        value={value}
        onChange={(next) => { docRef.setValue("translations", next); refresh((n) => n + 1); }}
        texts={texts}
        languages={all}
        base={base}
        mode="layout"
        hintFor={hintFor}
      />
    </div>
  );
}
