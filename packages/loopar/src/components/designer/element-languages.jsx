import { useMemo, useState } from "react";
import { useDocument } from "@loopar/document";
import { useWorkspace } from "@workspace/workspace-provider";
import { elementsDict } from "@global/element-definition";
import { Button } from "@cn/components/ui/button";
import { Input } from "@cn/components/ui/input";
import { Textarea } from "@cn/components/ui/textarea";
import { Badge } from "@cn/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@cn/components/ui/dialog";
import { LanguagesIcon, LoaderCircleIcon, SparklesIcon } from "lucide-react";
import { WEBSITE_BUILDERS, translationTargets } from "../translation/translations-panel";
import loopar from "loopar";
import { __, currentLanguage, languageName } from "@global/i18n";
import {
  contentTextProps, parseTranslations, compactTranslations, entryValue, entryState, makeEntry, isMachine,
} from "@global/i18n-content";

const LONG_TEXT = 90;

/**
 * "Languages" of the element being edited in the designer: its texts in
 * each language, stored in the record's `translations` (by node key and
 * prop). On website pages they are the page's translations; on entities
 * and forms they override the dictionary for this element only (a label
 * that needs another wording in its context).
 */
export function ElementLanguages({ elementKey, element, data }) {
  const { docRef, Document } = useDocument();
  const { __META__ } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({});
  // What the AI proposed, per draft key: kept "machine" while left unchanged.
  const [fromAI, setFromAI] = useState({});
  const [aiBusy, setAiBusy] = useState(false);

  const builder = Document?.Entity?.name;
  const website = WEBSITE_BUILDERS.has(builder);
  const hasField = useMemo(
    () => String(Document?.Entity?.doc_structure || "").includes('"name":"translations"'),
    [Document?.Entity?.doc_structure]
  );

  const { base, languages } = translationTargets(__META__, website);

  const props = contentTextProps(element, elementsDict[element]?.def)
    .filter((p) => typeof data?.[p] === "string" && data[p].trim() !== "");

  if (!hasField || !docRef?.setValue || !props.length) return null;

  const read = () => parseTranslations(docRef.getValue?.("translations") ?? docRef.Form?.getValues?.("translations"));

  const start = () => {
    const all = read();
    const next = {};
    const machine = {};
    for (const lang of languages) {
      for (const p of props) {
        const entry = all[lang]?.[elementKey]?.[p];
        next[`${lang}|${p}`] = entryValue(entry);
        if (isMachine(entry)) machine[`${lang}|${p}`] = entryValue(entry);
      }
    }
    setDraft(next);
    setFromAI(machine);
    setOpen(true);
  };

  const save = () => {
    const all = read();
    for (const lang of languages) {
      for (const p of props) {
        const value = draft[`${lang}|${p}`] ?? "";
        const prev = all[lang]?.[elementKey]?.[p];
        const machine = fromAI[`${lang}|${p}`] !== undefined && fromAI[`${lang}|${p}`] === value;
        if (value === entryValue(prev) && entryState(prev, data[p]) !== "outdated" && machine === isMachine(prev)) continue;
        all[lang] ??= {};
        all[lang][elementKey] = { ...(all[lang][elementKey] || {}), [p]: makeEntry(value, data[p], { machine }) };
      }
    }
    docRef.setValue("translations", JSON.stringify(compactTranslations(all)));
    setOpen(false);
  };

  const current = read();

  /** Empty fields of every language through the AI (marked until a person changes or keeps them). */
  const translateWithAI = async () => {
    setAiBusy(true);
    try {
      const proposed = {};
      for (const lang of languages) {
        const empty = props.filter((p) => !draft[`${lang}|${p}`]);
        if (!empty.length) continue;
        const r = await loopar.call("Translator", "aiTranslateTexts", {
          freeze: false,
          body: { lang, from: base, texts: JSON.stringify(empty.map((p) => ({ id: p, text: data[p], context: `${element} ${p}` }))) },
        });
        for (const p of empty) if (r.translations?.[p]) proposed[`${lang}|${p}`] = r.translations[p];
      }
      setDraft((d) => ({ ...d, ...proposed }));
      setFromAI((m) => ({ ...m, ...proposed }));
    } catch { /* toast shown */ }
    setAiBusy(false);
  };

  return (
    <>
      <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 px-2" onClick={start} title={__("Texts of this element in other languages")}>
        <LanguagesIcon className="size-4" />
        {__("Languages")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{__("Languages")} · {element}</DialogTitle>
            <DialogDescription>
              {website
                ? __("This element's texts in the site's other languages. Empty: the {0} text is shown.", [languageName(base)])
                : __("Overrides the dictionary for this element only. Empty: the dictionary translation is used.")}
            </DialogDescription>
          </DialogHeader>
          {languages.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {website
                ? __("To translate this content, add languages to the website: App → Website → Languages.")
                : __("There is no dictionary in another language yet: add one in the Translator.")}
            </p>
          ) : (
            <div className="flex flex-col gap-5">
              {props.map((p) => (
                <div key={p} className="flex flex-col gap-2">
                  <div className="rounded-md bg-muted/40 p-2 text-sm">
                    <Badge variant="secondary" className="mb-1 font-normal">{p} · {languageName(base)}</Badge>
                    <p className="whitespace-pre-wrap break-words text-muted-foreground">{data[p]}</p>
                  </div>
                  {languages.map((lang) => {
                    const key = `${lang}|${p}`;
                    const long = data[p].length > LONG_TEXT || data[p].includes("\n");
                    const Field = long ? Textarea : Input;
                    const outdated = entryState(current[lang]?.[elementKey]?.[p], data[p]) === "outdated";
                    const machine = fromAI[key] !== undefined && fromAI[key] === draft[key];
                    // On the desk's own language the dictionary translation is the hint.
                    const hint = !website && lang === currentLanguage() ? __(data[p]) : "";
                    return (
                      <label key={key} className="grid gap-1 text-xs font-medium text-muted-foreground sm:grid-cols-[8rem_1fr] sm:items-start sm:gap-3">
                        <span className="pt-2">
                          {languageName(lang)}
                          {outdated && <span className="block font-normal text-amber-700 dark:text-amber-300">{__("Outdated")}</span>}
                          {machine && <span className="block font-normal text-sky-700 dark:text-sky-300">{__("AI, unreviewed")}</span>}
                        </span>
                        <Field
                          value={draft[key] ?? ""}
                          rows={long ? 4 : undefined}
                          placeholder={hint && hint !== data[p] ? hint : __("Translation in {0}", [languageName(lang)])}
                          onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
                        />
                      </label>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
          <DialogFooter className="gap-2 sm:justify-between">
            {languages.length > 0 ? (
              <Button type="button" variant="ghost" disabled={aiBusy} onClick={translateWithAI}>
                {aiBusy ? <LoaderCircleIcon className="mr-1 size-4 animate-spin" /> : <SparklesIcon className="mr-1 size-4" />}
                {__("Fill empty ones with AI")}
              </Button>
            ) : <span />}
            <span className="flex gap-2">
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>{__("Cancel")}</Button>
            {languages.length > 0 && <Button type="button" onClick={save}>{__("Apply")}</Button>}
            </span>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
