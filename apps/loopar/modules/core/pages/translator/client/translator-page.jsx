'use strict';

import { useCallback, useEffect, useMemo, useState } from "react";
import { useDocument } from "@loopar/document";
import { PageLayout } from "@loopar/page";
import { loopar, __ } from "loopar";
import { Button } from "@cn/components/ui/button";
import { Input } from "@cn/components/ui/input";
import { Textarea } from "@cn/components/ui/textarea";
import { cn } from "@cn/lib/utils";
import { LanguagesIcon, SaveIcon, SearchIcon, SparklesIcon, Trash2Icon, LoaderCircleIcon, FileCodeIcon } from "lucide-react";
import { languageName } from "@global/i18n";
import { Pill, Panel, Empty } from "../../../../debug/ui/shared.jsx";

const call = (action, opts = {}) => loopar.call("Translator", action, { freeze: false, ...opts });
const PAGE = 80;

// Labels are built at render time: __() needs the page's language.
const filters = () => [
  ["all", __("All")],
  ["missing", __("Untranslated")],
  ["suggested", __("Suggestions")],
  ["translated", __("Translated")],
  ["inherited", __("From dependencies")],
  ["orphan", __("No longer used")],
  ["machine", __("AI, unreviewed")],
];

const statusOf = (entry) => ({
  translated: { tone: "success", label: __("Translated") },
  missing: { tone: "warning", label: __("Untranslated") },
  inherited: { tone: "info", label: __("From {0}", [targetLabel(entry.provider)]) },
  orphan: { tone: "muted", label: __("No longer used") },
})[entry.status];

const targetLabel = (t) => (t === "framework" ? __("Framework") : t);

/** One string: original, where it is used, its translation and state. */
function Row({ entry, value, override, where, onChange, machine, reviewed, onReview }) {
  const status = statusOf(entry);
  const long = entry.key.length > 70 || entry.key.includes("\n");
  const Field = long ? Textarea : Input;
  const shown = value !== undefined ? value : where === "site" ? (override || "") : entry.translation;
  const placeholder = where === "site" ? (entry.translation || __("Same as the app")) : __("Translation");

  return (
    <div className="grid gap-2 border-b border-border py-3 md:grid-cols-2 md:gap-4">
      <div className="min-w-0">
        <p className="whitespace-pre-wrap break-words text-sm">{entry.key}</p>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <Pill tone={status.tone}>{status.label}</Pill>
          {override && where !== "site" && <Pill tone="primary">{__("Site override")}</Pill>}
          {machine && !reviewed && <Pill tone="info">{__("AI, unreviewed")}</Pill>}
          {entry.sources?.slice(0, 2).map((s) => (
            <span key={s} title={entry.sources.join("\n")} className="inline-flex max-w-full items-center gap-1 truncate text-[11px] text-muted-foreground">
              <FileCodeIcon className="size-3 shrink-0" />{s.split("/").slice(-2).join("/")}
            </span>
          ))}
          {entry.sources?.length > 2 && <span className="text-[11px] text-muted-foreground" title={entry.sources.join("\n")}>+{entry.sources.length - 2}</span>}
        </div>
      </div>
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex items-start gap-2">
          <Field
            value={shown}
            rows={long ? 3 : undefined}
            placeholder={placeholder}
            onChange={(e) => onChange(entry.key, e.target.value)}
            className={cn(value !== undefined && "border-primary")}
          />
          {entry.status === "orphan" && where === "app" && (
            <Button type="button" variant="ghost" size="icon" title={__("Remove from the dictionary")} onClick={() => onChange(entry.key, null)}>
              <Trash2Icon className="size-4" />
            </Button>
          )}
        </div>
        {machine && !reviewed && value === undefined && (
          <button type="button" onClick={() => onReview(entry.key)} className="self-start text-xs text-muted-foreground underline hover:text-foreground">
            {__("Mark as reviewed")}
          </button>
        )}
        {entry.suggestion && !shown && (
          <button
            type="button"
            onClick={() => onChange(entry.key, entry.suggestion.translation)}
            className="flex items-start gap-1.5 rounded-md bg-primary/5 p-2 text-left text-xs text-muted-foreground hover:bg-primary/10"
          >
            <SparklesIcon className="mt-0.5 size-3.5 shrink-0 text-primary" />
            <span>
              {__("Use \"{0}\" — translation of \"{1}\", its previous wording.", [entry.suggestion.translation, entry.suggestion.from])}
            </span>
          </button>
        )}
      </div>
    </div>
  );
}

function TranslatorView({ data }) {
  const [target, setTarget] = useState(data.targets.includes("loopar") ? "loopar" : data.targets[0]);
  const [lang, setLang] = useState(data.defaultLanguage);
  const [where, setWhere] = useState(data.development ? "app" : "site");
  const [catalog, setCatalog] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [filter, setFilter] = useState("missing");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [changes, setChanges] = useState({});
  // AI proposals not saved yet (key → text) and saved AI translations accepted as they are.
  const [aiDraft, setAiDraft] = useState({});
  const [reviewed, setReviewed] = useState(() => new Set());
  const [aiBusy, setAiBusy] = useState(false);
  const languages = useMemo(() => [...new Set([...data.languages, lang])].sort(), [data.languages, lang]);
  const dirty = Object.keys(changes).length + reviewed.size;
  const savedMachine = (e) => (where === "site" ? !!e.overrideMachine : !!e.machine);
  const isMachine = (e) => (changes[e.key] !== undefined ? aiDraft[e.key] === changes[e.key] : savedMachine(e));

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await call("catalog", { query: { target, lang } });
      setCatalog(r.catalog);
      setChanges({});
      setAiDraft({});
      setReviewed(new Set());
    } catch { /* toast shown */ }
    setLoading(false);
  }, [target, lang]);

  useEffect(() => { load(); }, [load]);

  const save = useCallback(async () => {
    if (!dirty) return;
    setSaving(true);
    try {
      const machine = Object.keys(changes).filter((k) => aiDraft[k] !== undefined && aiDraft[k] === changes[k]);
      const r = await call("save", {
        body: { target, lang, where, changes: JSON.stringify(changes), machine: JSON.stringify(machine), reviewed: JSON.stringify([...reviewed]) },
      });
      setCatalog(r.catalog);
      setChanges({});
      setAiDraft({});
      setReviewed(new Set());
      loopar.notify(__("{0} translations saved", [r.result.changed]));
    } catch { /* toast shown */ }
    setSaving(false);
  }, [target, lang, where, changes, dirty, aiDraft, reviewed]);

  /** Untranslated texts through the AI: they arrive as unsaved changes marked "AI". */
  const translateWithAI = useCallback(async () => {
    setAiBusy(true);
    try {
      const r = await call("aiTranslate", { body: { target, lang } });
      const got = r.translations || {};
      setChanges((c) => ({ ...c, ...got }));
      setAiDraft((d) => ({ ...d, ...got }));
      const n = Object.keys(got).length;
      loopar.notify(
        r.failed?.length
          ? __("{0} texts translated; {1} need a person (the AI changed placeholders or tags).", [n, r.failed.length])
          : r.remaining
            ? __("{0} texts translated, {1} left: run it again after saving.", [n, r.remaining])
            : __("{0} texts translated. Review them and save.", [n]),
        r.failed?.length ? "warning" : "success"
      );
    } catch { /* toast shown */ }
    setAiBusy(false);
  }, [target, lang]);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); save(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  const guardSwitch = (fn) => (value) => {
    if (!dirty) return fn(value);
    loopar.confirm(__("Discard the unsaved translations?"), () => fn(value));
  };

  const entries = catalog?.entries || [];
  const counts = useMemo(() => {
    const c = { all: 0, missing: 0, suggested: 0, translated: 0, inherited: 0, orphan: 0, machine: 0 };
    for (const e of entries) {
      if (e.status !== "orphan") c.all++;
      c[e.status]++;
      if (e.suggestion) c.suggested++;
      if (isMachine(e) && !reviewed.has(e.key)) c.machine++;
    }
    return c;
  }, [entries, changes, aiDraft, reviewed, where]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter((e) => {
      const out = filter === "all" ? e.status === "orphan"
        : filter === "suggested" ? !e.suggestion
        : filter === "machine" ? !(isMachine(e) && !reviewed.has(e.key))
        : e.status !== filter;
      if (out) return false;
      if (!q) return true;
      return e.key.toLowerCase().includes(q) || (e.translation || "").toLowerCase().includes(q) || (changes[e.key] || "").toLowerCase().includes(q);
    });
  }, [entries, filter, query, changes, aiDraft, reviewed, where]);

  const total = counts.all || 0;
  const done = counts.translated + counts.inherited;
  const percent = total ? Math.round((done / total) * 100) : 0;

  return (
    <div className="flex flex-col gap-4">
      <Panel bodyClassName="flex flex-col gap-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
            {__("App")}
            <select className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground" value={target} onChange={(e) => guardSwitch(setTarget)(e.target.value)}>
              {data.targets.map((t) => <option key={t} value={t}>{targetLabel(t)}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
            {__("Language")}
            <select className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground" value={lang} onChange={(e) => guardSwitch(setLang)(e.target.value)}>
              {languages.map((l) => <option key={l} value={l}>{languageName(l)}</option>)}
              <optgroup label={__("Add a language")}>
                {data.allLanguages.filter((l) => !languages.includes(l)).map((l) => <option key={l} value={l}>{languageName(l)}</option>)}
              </optgroup>
            </select>
          </label>
          <div className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
            {__("Save to")}
            <div role="tablist" className="flex h-9 gap-1 rounded-lg bg-muted/60 p-1">
              {[["app", __("The app's file")], ["site", __("This site only")]].map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={where === value}
                  disabled={value === "app" && !data.development}
                  title={value === "app" && !data.development ? __("Apps' files are edited in development") : undefined}
                  onClick={() => guardSwitch(setWhere)(value)}
                  className={cn("rounded-md px-3 text-sm font-medium disabled:opacity-40", where === value ? "bg-background text-foreground shadow-sm" : "hover:text-foreground")}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <Button type="button" variant="secondary" className="ml-auto" disabled={aiBusy || !counts.missing} onClick={translateWithAI}>
            {aiBusy ? <LoaderCircleIcon className="mr-1 size-4 animate-spin" /> : <SparklesIcon className="mr-1 size-4" />}
            {__("Translate pending with AI")}
          </Button>
          <Button type="button" disabled={!dirty || saving} onClick={save}>
            {saving ? <LoaderCircleIcon className="mr-1 size-4 animate-spin" /> : <SaveIcon className="mr-1 size-4" />}
            {dirty ? __("Save {0} changes", [dirty]) : __("Save")}
          </Button>
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between text-sm">
            <span>{__("{0} of {1} texts translated", [done, total])}</span>
            <span className="text-muted-foreground">{catalog?.file}</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div className="h-full bg-primary transition-all" style={{ width: `${percent}%` }} />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div role="tablist" className="flex flex-wrap gap-1 rounded-lg bg-muted/60 p-1">
            {filters().map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={filter === value}
                onClick={() => { setFilter(value); setLimit(PAGE); }}
                className={cn("rounded-md px-2.5 py-1 text-xs font-medium", filter === value ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}
              >
                {label} <span className="tabular-nums opacity-70">{counts[value] ?? 0}</span>
              </button>
            ))}
          </div>
          <div className="relative ml-auto w-full max-w-xs">
            <SearchIcon className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
            <Input className="pl-8" value={query} placeholder={__("Search texts…")} onChange={(e) => { setQuery(e.target.value); setLimit(PAGE); }} />
          </div>
        </div>
      </Panel>

      <Panel bodyClassName="py-0">
        {loading && !catalog ? (
          <Empty>{__("Reading the app's texts…")}</Empty>
        ) : visible.length === 0 ? (
          <Empty>{filter === "missing" ? __("Every text is translated.") : __("No texts here.")}</Empty>
        ) : (
          <>
            {visible.slice(0, limit).map((e) => (
              <Row
                key={e.key}
                entry={e}
                where={where}
                override={e.override}
                value={changes[e.key]}
                machine={isMachine(e)}
                reviewed={reviewed.has(e.key)}
                onReview={(key) => setReviewed((r) => new Set(r).add(key))}
                onChange={(key, value) => setChanges((c) => ({ ...c, [key]: value }))}
              />
            ))}
            {visible.length > limit && (
              <div className="py-3 text-center">
                <Button type="button" variant="secondary" onClick={() => setLimit(limit + PAGE)}>
                  {__("Show {0} more", [Math.min(PAGE, visible.length - limit)])}
                </Button>
              </div>
            )}
          </>
        )}
      </Panel>
    </div>
  );
}

export default function TranslatorPage() {
  const { Document } = useDocument();
  const data = Document?.data;
  return (
    <PageLayout>
      {data ? <TranslatorView data={data} /> : <Empty><LanguagesIcon className="mx-auto mb-2 size-6" /></Empty>}
    </PageLayout>
  );
}
