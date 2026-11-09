import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { useWatch } from "react-hook-form";
import { BaseFormContext } from "@form-context";
import { FormLabelAddonContext } from "@cn/components/ui/form";
import { Button } from "@cn/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@cn/components/ui/dialog";
import { useWorkspace } from "@workspace/workspace-provider";
import { cn } from "@cn/lib/utils";
import { LanguagesIcon } from "lucide-react";
import { __, languageName } from "@global/i18n";
import { parseTranslations, entryState, isMachine } from "@global/i18n-content";
import { TranslationsPanel, translationTargets, panelLanguages, NoLanguages } from "./translations-panel";

const TRUE = [1, "1", true, "true"];

/** Translatable fields of an entity structure: [{ key: name, label, element }]. */
export function translatableFields(structure) {
  const out = [];
  const walk = (nodes) => {
    for (const n of Array.isArray(nodes) ? nodes : []) {
      if (n?.data?.name && TRUE.includes(n.data.translatable)) {
        out.push({ key: n.data.name, label: n.data.label || n.data.name, element: n.element });
      }
      walk(n?.elements);
    }
  };
  try { walk(typeof structure === "string" ? JSON.parse(structure || "[]") : structure); } catch { /* no fields */ }
  return out;
}

/**
 * Translations of a record's translatable fields, for one form: what the
 * label icons and the header button share. Records with translatable fields
 * are website content (posts, services, the footer…), so they are written in
 * the site's default language and go to its other languages.
 */
const RecordTranslationsContext = createContext(null);

function useRecordTranslationsState(entity) {
  const form = useContext(BaseFormContext);
  const { __META__ } = useWorkspace();
  const fields = useMemo(() => translatableFields(entity?.doc_structure), [entity?.doc_structure]);
  const { base, languages } = translationTargets(__META__, true);

  const watched = useWatch({ control: form?.control, name: ["translations", ...fields.map((f) => f.key)], disabled: !form || !fields.length });
  const stored = watched?.[0] ?? "";

  // Base texts: the current value of each field, as typed in the form.
  const texts = useMemo(() => fields.map((f, i) => {
    const v = watched?.[i + 1];
    return { ...f, prop: f.key, value: v == null ? "" : String(v) };
  }), [fields, watched]);

  const setStored = useCallback((next) => form?.setValue("translations", next, { shouldDirty: true }), [form]);

  return useMemo(() => {
    if (!form || !fields.length) return null;
    return {
      base, stored, setStored, texts,
      languages: panelLanguages(stored, base, languages),
      fieldNames: new Set(fields.map((f) => f.key)),
    };
  }, [form, fields, base, languages, stored, setStored, texts]);
}

/** Worst state of a field across the target languages, for the icon's color. */
function fieldState(state, key) {
  const translations = parseTranslations(state.stored);
  const text = state.texts.find((t) => t.key === key);
  if (!text?.value.trim()) return "empty";
  const entries = state.languages.map((l) => translations[l]?.[key]);
  const states = entries.map((e) => entryState(e, text.value));
  if (states.includes("missing")) return "missing";
  if (states.includes("outdated")) return "outdated";
  if (entries.some((e) => isMachine(e))) return "machine";
  return "translated";
}

const ICON_CLASS = {
  empty: "text-muted-foreground/50",
  missing: "text-muted-foreground",
  outdated: "text-amber-600 dark:text-amber-400",
  machine: "text-sky-600 dark:text-sky-400",
  translated: "text-primary",
};

const STATE_TITLE = {
  empty: () => __("Translations"),
  missing: () => __("Translations: pending"),
  outdated: () => __("Translations: the text changed after it was translated"),
  machine: () => __("Translations: AI, unreviewed"),
  translated: () => __("Translations: up to date"),
};

/** The translation editor of a record, limited to `keys` (one field) or all of them. */
function TranslationsDialog({ state, keys, title, open, onOpenChange }) {
  const texts = keys ? state.texts.filter((t) => keys.includes(t.key)) : state.texts.filter((t) => t.value.trim() !== "");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><LanguagesIcon className="size-4" />{title}</DialogTitle>
          <DialogDescription>
            {state.languages.length
              ? __("Written in {0}. Visitors of the site in another language see these texts; empty ones fall back to the original.", [languageName(state.base)])
              : null}
          </DialogDescription>
        </DialogHeader>
        {state.languages.length ? (
          <TranslationsPanel
            value={state.stored}
            onChange={state.setStored}
            texts={texts}
            languages={state.languages}
            base={state.base}
            mode="fields"
            compact={!!keys}
          />
        ) : <NoLanguages website />}
      </DialogContent>
    </Dialog>
  );
}

/** The icon next to a translatable field's label. */
function FieldTranslateButton({ name }) {
  const state = useContext(RecordTranslationsContext);
  const [open, setOpen] = useState(false);
  if (!state) return null;
  const s = fieldState(state, name);
  const label = state.texts.find((t) => t.key === name)?.label || name;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={STATE_TITLE[s]()}
        aria-label={`${__("Translations")} · ${__(label)}`}
        className={cn("inline-flex size-6 shrink-0 items-center justify-center rounded-md hover:bg-muted", ICON_CLASS[s])}
      >
        <LanguagesIcon className="size-4" />
      </button>
      {open && <TranslationsDialog state={state} keys={[name]} title={`${__("Translations")} · ${__(label)}`} open={open} onOpenChange={setOpen} />}
    </>
  );
}

/**
 * Around a record form: a translate icon next to the label of every
 * translatable field (shown once the site has other languages). Writes the
 * record's `translations` field; nothing to do for entities without
 * translatable fields.
 */
export function RecordTranslations({ entity, children }) {
  const state = useRecordTranslationsState(entity);
  const addon = useCallback(
    (name) => (state?.languages.length && state.fieldNames.has(name) ? <FieldTranslateButton name={name} /> : null),
    [state]
  );
  if (!state) return children;
  return (
    <RecordTranslationsContext.Provider value={state}>
      <FormLabelAddonContext.Provider value={addon}>{children}</FormLabelAddonContext.Provider>
    </RecordTranslationsContext.Provider>
  );
}

/** The record's translations state, or null (no translatable fields, or not a record form). */
export const useRecordTranslations = () => useContext(RecordTranslationsContext);

/** Header button: every translatable field of the record at once (AI included). */
export function RecordTranslationsButton() {
  const state = useContext(RecordTranslationsContext);
  const [open, setOpen] = useState(false);
  if (!state) return null;
  return (
    <>
      <Button variant="secondary" className="px-2" onClick={() => setOpen(true)} title={__("Translations")} aria-label={__("Translations")}>
        <LanguagesIcon />
        <span className="lp-menu-label pl-1">{__("Translations")}</span>
      </Button>
      {open && <TranslationsDialog state={state} title={__("Translations")} open={open} onOpenChange={setOpen} />}
    </>
  );
}
