import { useMemo, useState } from "react";
import loopar, { elementsDict } from "loopar";
import { Button } from "@cn/components/ui/button";
import { Input } from "@cn/components/ui/input";
import { Textarea } from "@cn/components/ui/textarea";
import { Badge } from "@cn/components/ui/badge";
import { Switch } from "@cn/components/ui/switch";
import { cn } from "@cn/lib/utils";
import { LoaderCircleIcon, SparklesIcon } from "lucide-react";
import { __, languageName } from "@global/i18n";
import { contentTexts, parseTranslations, compactTranslations, entryValue, entryState, makeEntry, isMachine } from "@global/i18n-content";

const LONG_TEXT = 90;
const LONG_ELEMENTS = new Set(["markdown", "markdown_input", "textarea", "text_editor"]);

export const definitionOf = (element) => elementsDict[element]?.def;

/** Builders whose content is website text, written in the site's default language. */
export const WEBSITE_BUILDERS = new Set(["Page Builder", "Contact Form Builder"]);

/**
 * Base language and target languages of what is being translated:
 * website content (pages, contact forms, records shown on the site) is
 * written in the site's default language and goes to the site's other
 * languages; desk definitions (entities, forms) are written in English
 * and go to the languages that have a dictionary.
 */
export function translationTargets(meta, website) {
  return website
    ? { base: meta?.content_languages?.base || "en", languages: meta?.content_languages?.languages || [] }
    : { base: "en", languages: meta?.ui_languages || [] };
}

/** Translatable texts of a layout (doc_structure nodes or its JSON). */
export function layoutTexts(structure) {
  try {
    const nodes = typeof structure === "string" ? JSON.parse(structure || "[]") : structure || [];
    return contentTexts(nodes, definitionOf);
  } catch {
    return [];
  }
}

/** Languages to show: the targets plus any already present in `value`, never the base. */
export function panelLanguages(value, base, languages) {
  return [...new Set([...languages, ...Object.keys(parseTranslations(value))])].filter((l) => l !== base);
}

/** When there is nothing to translate into. */
export function NoLanguages({ website }) {
  return (
    <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
      {website
        ? __("To translate this content, add languages to the website: App → Website → Languages.")
        : __("There is no dictionary in another language yet: add one in the Translator.")}
    </p>
  );
}

/**
 * Translation editor: every text next to its translation in the selected
 * language, like a store's "Translate" screen. Shared by the designer's
 * "Translations" tab (layouts: pages, forms, entities) and the
 * "Translations" section of records with translatable fields.
 *
 * @param value     the `translations` value (JSON text or object)
 * @param onChange  receives the new `translations` JSON text
 * @param texts     [{ key, prop, value, element, label? }] base texts
 * @param mode      "layout" (layer[nodeKey][prop]) | "fields" (layer[field])
 * @param hintFor   optional (text, language) => placeholder (dictionary translation)
 * @param compact   one or few texts (a single field): no "Pending only" filter
 */
export function TranslationsPanel({ value: stored, onChange, texts, languages, base, mode, hintFor, compact }) {
  const [language, setLanguage] = useState(languages[0]);
  const [onlyMissing, setOnlyMissing] = useState(false);

  const translations = useMemo(() => parseTranslations(stored), [stored]);
  if (!languages.includes(language) && languages.length) setLanguage(languages[0]);

  const layer = translations[language] || {};
  // Pages: layer[nodeKey][prop]. Records: layer[fieldName].
  const entryOf = (t) => (mode === "fields" ? layer[t.key] : layer[t.key]?.[t.prop]);
  const valueOf = (t) => entryValue(entryOf(t));
  const stateOf = (t) => entryState(entryOf(t), t.value);
  const done = texts.filter((t) => stateOf(t) === "translated").length;
  const outdated = texts.filter((t) => stateOf(t) === "outdated").length;
  const rows = onlyMissing ? texts.filter((t) => stateOf(t) !== "translated") : texts;

  const machineCount = texts.filter((t) => isMachine(entryOf(t))).length;
  const [aiBusy, setAiBusy] = useState(false);

  // Every edit records the base text it was translated from (see entryState);
  // a person's edit (or review) clears the "machine" mark.
  const updateMany = (pairs, { machine = false } = {}) => {
    const next = structuredClone(translations);
    next[language] ??= {};
    for (const [t, value] of pairs) {
      const entry = makeEntry(value, t.value, { machine });
      if (mode === "fields") next[language][t.key] = entry;
      else next[language][t.key] = { ...(next[language][t.key] || {}), [t.prop]: entry };
    }
    onChange(JSON.stringify(compactTranslations(next)));
  };
  const update = (t, value) => updateMany([[t, value]]);

  /** Pending texts (missing or outdated) of this language through the AI; stored as unreviewed. */
  const translateWithAI = async () => {
    const pending = texts.filter((t) => stateOf(t) !== "translated");
    if (!pending.length) return;
    const id = (t) => `${t.key}|${t.prop}`;
    setAiBusy(true);
    try {
      const r = await loopar.call("Translator", "aiTranslateTexts", {
        freeze: false,
        body: {
          lang: language,
          from: base,
          texts: JSON.stringify(pending.map((t) => ({ id: id(t), text: t.value, context: mode === "fields" ? __(t.label) : `${t.element} ${t.prop}` }))),
        },
      });
      const pairs = pending.filter((t) => r.translations?.[id(t)]).map((t) => [t, r.translations[id(t)]]);
      if (pairs.length) updateMany(pairs, { machine: true });
      loopar.notify(r.failed?.length
        ? __("{0} texts translated; {1} need a person (the AI changed placeholders or tags).", [pairs.length, r.failed.length])
        : __("{0} texts translated. Review them before publishing.", [pairs.length]), r.failed?.length ? "warning" : "success");
    } catch { /* toast shown */ }
    setAiBusy(false);
  };

  return (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            {languages.length > 1 && (
              <div role="tablist" className="flex gap-1 rounded-lg bg-muted/60 p-1">
                {languages.map((l) => (
                  <button
                    key={l}
                    type="button"
                    role="tab"
                    aria-selected={l === language}
                    onClick={() => setLanguage(l)}
                    className={cn(
                      "rounded-md px-3 py-1 text-sm font-medium",
                      l === language ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    {languageName(l)}
                  </button>
                ))}
              </div>
            )}
            <span className="text-sm text-muted-foreground">
              {__("{0} of {1} texts translated", [done, texts.length])}
            </span>
            {outdated > 0 && <Badge variant="outline" className="border-amber-500/40 text-amber-700 dark:text-amber-300">{__("{0} outdated", [outdated])}</Badge>}
            {machineCount > 0 && <Badge variant="outline" className="border-sky-500/40 text-sky-700 dark:text-sky-300">{__("AI, unreviewed: {0}", [machineCount])}</Badge>}
            <Button type="button" variant="secondary" size="sm" disabled={aiBusy || done === texts.length} onClick={translateWithAI}>
              {aiBusy ? <LoaderCircleIcon className="mr-1 size-4 animate-spin" /> : <SparklesIcon className="mr-1 size-4" />}
              {__("Translate pending with AI")}
            </Button>
            {!compact && (
              <label className="ml-auto flex items-center gap-2 text-sm">
                <Switch checked={onlyMissing} onCheckedChange={setOnlyMissing} />
                {__("Pending only")}
              </label>
            )}
          </div>

          {rows.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {texts.length ? __("Every text is translated.") : __("There are no texts to translate yet.")}
            </p>
          ) : (
            <div className="grid gap-x-4 gap-y-3 md:grid-cols-2">
              <div className="hidden text-xs font-semibold uppercase text-muted-foreground md:block">{languageName(base)}</div>
              <div className="hidden text-xs font-semibold uppercase text-muted-foreground md:block">{languageName(language)}</div>
              {rows.map((t) => {
                const value = valueOf(t);
                const state = stateOf(t);
                const machine = isMachine(entryOf(t));
                const long = t.value.length > LONG_TEXT || t.value.includes("\n") || LONG_ELEMENTS.has(t.element);
                return (
                  <div key={`${t.key}:${t.prop}`} className="contents">
                    <div className="min-w-0 rounded-md bg-muted/40 p-2 text-sm">
                      <Badge variant="secondary" className="mb-1 font-normal">{mode === "fields" ? __(t.label) : `${t.element} · ${t.prop}`}</Badge>
                      <p className="line-clamp-4 whitespace-pre-wrap break-words text-muted-foreground">{t.value}</p>
                      {machine && state !== "outdated" && (
                        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-sky-700 dark:text-sky-300">
                          {__("AI translation, unreviewed.")}
                          <button type="button" className="underline" onClick={() => update(t, value)}>{__("Mark as reviewed")}</button>
                        </div>
                      )}
                      {state === "outdated" && (
                        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-amber-700 dark:text-amber-300">
                          {__("The text changed after it was translated.")}
                          <button type="button" className="underline" onClick={() => update(t, value)}>{__("Mark as reviewed")}</button>
                        </div>
                      )}
                    </div>
                    {long ? (
                      <Textarea
                        value={value}
                        rows={Math.min(12, Math.max(3, Math.ceil(t.value.length / 80)))}
                        placeholder={hintFor?.(t, language) || __("Translation in {0}", [languageName(language)])}
                        onChange={(e) => update(t, e.target.value)}
                      />
                    ) : (
                      <Input
                        value={value}
                        placeholder={hintFor?.(t, language) || __("Translation in {0}", [languageName(language)])}
                        onChange={(e) => update(t, e.target.value)}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
  );
}

