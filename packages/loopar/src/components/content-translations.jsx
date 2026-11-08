import { useMemo, useState } from "react";
import { useWatch } from "react-hook-form";
import BaseInput from "@base-input";
import { useFormContext } from "@form-context";
import { useDocument } from "@loopar/document";
import { useWorkspace } from "@workspace/workspace-provider";
import loopar, { elementsDict } from "loopar";
import { Button } from "@cn/components/ui/button";
import { Input } from "@cn/components/ui/input";
import { Textarea } from "@cn/components/ui/textarea";
import { Badge } from "@cn/components/ui/badge";
import { Switch } from "@cn/components/ui/switch";
import { cn } from "@cn/lib/utils";
import { ChevronDownIcon, LanguagesIcon, LoaderCircleIcon, SparklesIcon } from "lucide-react";
import { __, languageName } from "@global/i18n";
import { contentTexts, parseTranslations, compactTranslations, entryValue, entryState, makeEntry, isMachine } from "@global/i18n-content";

const definitionOf = (element) => elementsDict[element]?.def;
const LONG_TEXT = 90;
const LONG_ELEMENTS = new Set(["markdown", "markdown_input", "textarea", "text_editor"]);
const TRUE = [1, "1", true, "true"];

/** Translatable fields of an entity structure: [{ key: name, label, element }]. */
function translatableFields(nodes, out = []) {
  for (const n of Array.isArray(nodes) ? nodes : []) {
    if (n?.data?.name && TRUE.includes(n.data.translatable)) {
      out.push({ key: n.data.name, label: n.data.label || n.data.name, element: n.element });
    }
    translatableFields(n?.elements, out);
  }
  return out;
}

/**
 * Translation editor of a page (the `translations` field of Page Builder):
 * every translatable text of the layout next to its translation in the
 * selected language, like a store's "Translate" screen. The layout is
 * edited in the designer, in the site's default language; here only the
 * texts of the other languages.
 */
function Editor({ field, texts, languages, base, mode }) {
  const [open, setOpen] = useState(false);
  const [language, setLanguage] = useState(languages[0]);
  const [onlyMissing, setOnlyMissing] = useState(false);

  const translations = useMemo(() => parseTranslations(field.value), [field.value]);

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
    field.onChange({ target: { value: JSON.stringify(compactTranslations(next)) } });
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
    <div className="rounded-lg border">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-4 py-3 text-left"
      >
        <LanguagesIcon className="size-4 text-muted-foreground" />
        <span className="font-medium">{__("Translations")}</span>
        <span className="text-sm text-muted-foreground">
          {languages.map((l) => languageName(l)).join(" · ")}
        </span>
        <ChevronDownIcon className={cn("ml-auto size-4 transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div className="flex flex-col gap-3 border-t p-4">
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
            <label className="ml-auto flex items-center gap-2 text-sm">
              <Switch checked={onlyMissing} onCheckedChange={setOnlyMissing} />
              {__("Pending only")}
            </label>
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
                        placeholder={__("Translation in {0}", [languageName(language)])}
                        onChange={(e) => update(t, e.target.value)}
                      />
                    ) : (
                      <Input
                        value={value}
                        placeholder={__("Translation in {0}", [languageName(language)])}
                        onChange={(e) => update(t, e.target.value)}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Page mode: the texts of the designer field (`data.source`, default doc_structure). */
function usePageTexts(control, source) {
  const structure = useWatch({ control, name: source || "doc_structure" });
  return useMemo(() => {
    try {
      const nodes = typeof structure === "string" ? JSON.parse(structure || "[]") : structure || [];
      return contentTexts(nodes, definitionOf);
    } catch { return []; }
  }, [structure]);
}

/** Fields mode: the record's translatable fields with their current (base) values. */
function useFieldTexts(control) {
  const { Document } = useDocument();
  const fields = useMemo(() => {
    try { return translatableFields(JSON.parse(Document?.Entity?.doc_structure || "[]")); } catch { return []; }
  }, [Document?.Entity?.doc_structure]);
  const values = useWatch({ control, name: fields.map((f) => f.key) });
  return useMemo(() => fields
    .map((f, i) => ({ ...f, prop: f.key, value: values?.[i] == null ? "" : String(values[i]) }))
    .filter((f) => f.value.trim() !== ""), [fields, values]);
}

function Translations({ props, mode, texts }) {
  const { __META__ } = useWorkspace();
  const { base = "en", languages = [] } = __META__?.content_languages || {};

  return (
    <BaseInput
      {...props}
      render={(field) => {
        // Languages already translated stay editable even if no site publishes them now.
        const all = [...new Set([...languages, ...Object.keys(parseTranslations(field.value))])].filter((l) => l !== base);
        if (!all.length) {
          return (
            <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
              {__("To translate this content, add languages to the website: App → Website → Languages.")}
            </p>
          );
        }
        return <Editor field={field} texts={texts} languages={all} base={base} mode={mode} />;
      }}
    />
  );
}

const PageTranslations = ({ props }) => {
  const { control } = useFormContext();
  return <Translations props={props} mode="page" texts={usePageTexts(control, props.data?.source)} />;
};

const FieldTranslations = ({ props }) => {
  const { control } = useFormContext();
  return <Translations props={props} mode="fields" texts={useFieldTexts(control)} />;
};

/**
 * `mode: "fields"` translates the record's translatable fields (added by
 * Entity when a field is marked translatable); otherwise the texts of a
 * page layout.
 */
export default function ContentTranslations(props) {
  return props.data?.mode === "fields" ? <FieldTranslations props={props} /> : <PageTranslations props={props} />;
}
