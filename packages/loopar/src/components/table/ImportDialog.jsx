import { useMemo, useRef, useState } from "react";
import loopar from "loopar";
import { DownloadIcon, FileUpIcon, Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@cn/components/ui/dialog";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@cn/components/ui/select";
import { Button } from "@cn/components/ui/button";
import { useWorkspace } from "@workspace/workspace-provider";
import { parseCsv, toCsv, csvFileName } from "@global/csv";
import { isImportableField, matchImportColumn, MAX_IMPORT_ROWS } from "@global/list-import";
import { __ } from "@global/i18n";
import { useTable } from "./TableContext";
import { downloadText } from "./list-url";

const SKIP = "__skip__";
const MAX_FILE_BYTES = 10 * 1024 * 1024;

/**
 * Import of records into the list from a CSV file (`{Entity}/import`,
 * global/list-import.js): pick the file, check which field each column
 * fills, validate without writing, then import. Rows fail on their own; the
 * ones that failed can be downloaded, fixed and imported again.
 */
export function ImportDialog({ open, onOpenChange }) {
  const { Document, baseColumns } = useTable();
  const { refresh } = useWorkspace();
  const entity = Document?.Entity?.name;
  const input = useRef(null);

  const fields = useMemo(() => {
    const seen = new Set();
    return baseColumns()
      .filter((el) => el?.data?.name && !el.isCustom && isImportableField(el) && !seen.has(el.data.name) && seen.add(el.data.name))
      .map((el) => ({ name: el.data.name, label: el.data.label || el.data.name, required: [1, "1", true, "true"].includes(el.data.required) }));
  }, [baseColumns]);

  const [file, setFile] = useState(null);        // { name, header: [text], rows: [[text]] }
  const [mapping, setMapping] = useState([]);    // field name (or null) per file column
  const [mode, setMode] = useState("insert");
  const [busy, setBusy] = useState(null);        // "validate" | "import"
  const [result, setResult] = useState(null);
  const [issue, setIssue] = useState(null);

  const reset = () => { setFile(null); setMapping([]); setResult(null); setIssue(null); if (input.current) input.current.value = ""; };

  const pick = async (picked) => {
    setResult(null);
    setIssue(null);
    if (!picked) return;
    if (picked.size > MAX_FILE_BYTES) return setIssue(__("The file is too large (10 MB at most)."));

    const [header = [], ...rows] = parseCsv(await picked.text());
    if (!header.length || !rows.length) return setIssue(__("The file has no rows to import."));
    if (rows.length > MAX_IMPORT_ROWS) return setIssue(__("An import takes up to {0} rows; this file has {1}.", [MAX_IMPORT_ROWS, rows.length]));

    // Each field is filled by one column: the first whose header matches.
    const taken = new Set();
    const auto = header.map((text) => {
      const name = matchImportColumn(text, fields);
      if (!name || taken.has(name)) return null;
      taken.add(name);
      return name;
    });
    setFile({ name: picked.name, header, rows });
    setMapping(auto);
  };

  const mapColumn = (index, name) => {
    setResult(null);
    // A field moved to this column leaves the one it had.
    setMapping((current) => current.map((value, i) => (i === index ? name : value === name ? null : value)));
  };

  const mapped = mapping.filter(Boolean);
  const missing = fields.filter((f) => f.required && f.name !== "name" && !mapped.includes(f.name));

  const send = async (dryRun) => {
    setBusy(dryRun ? "validate" : "import");
    setIssue(null);
    try {
      const records = file.rows.map((row) => Object.fromEntries(
        mapping.map((name, i) => (name ? [name, row[i] ?? ""] : null)).filter(Boolean)
      ));
      const response = await loopar.call(entity, "import", { body: { records, mode, dry_run: dryRun ? 1 : 0 }, freeze: false, notifyError: false });
      setResult(response);
      if (!dryRun && (response.created || response.updated)) refresh();
    } catch (e) {
      setIssue(e?.message || __("The import could not be done."));
    } finally {
      setBusy(null);
    }
  };

  const downloadTemplate = () => downloadText(csvFileName(`${entity} template`), toCsv([fields.map((f) => f.label)]));

  /** The rows that failed, as they came, plus why: fix them and import that file. */
  const downloadFailed = () => {
    const failed = (result?.issues || []).map((i) => [...(file.rows[i.row - 2] || []), i.message]);
    downloadText(csvFileName(`${entity} import errors`), toCsv([[...file.header, __("Error")], ...failed]));
  };

  const done = result && !result.dry_run;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) reset(); onOpenChange(next); }}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><FileUpIcon className="size-4" />{__("Import {0}", [__(entity)])}</DialogTitle>
          <DialogDescription>
            {__("Records from a CSV file. The first row holds the column names; each record is saved as if it were typed in the form.")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={input} type="file" accept=".csv,text/csv,text/plain" className="hidden"
            onChange={(e) => pick(e.target.files?.[0])}
          />
          <Button type="button" variant="outline" className="h-9 gap-1" onClick={() => input.current?.click()}>
            <FileUpIcon className="size-4" />
            {file ? __("Choose another file") : __("Choose a file")}
          </Button>
          {file && <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{file.name} · {__("{0} rows", [file.rows.length])}</span>}
          {!file && <div className="flex-1" />}
          <Button type="button" variant="ghost" className="h-9 gap-1" onClick={downloadTemplate} title={__("An empty file with this list's columns")}>
            <DownloadIcon className="size-4" />
            {__("Template")}
          </Button>
        </div>

        {issue && <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">{issue}</p>}

        {file && (
          <>
            <div className="rounded-md border">
              <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] gap-2 border-b bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground">
                <span>{__("Column in the file")}</span>
                <span>{__("First value")}</span>
                <span>{__("Field")}</span>
              </div>
              <div className="max-h-64 overflow-y-auto">
                {file.header.map((text, index) => (
                  <div key={index} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] items-center gap-2 border-b px-3 py-1.5 text-sm last:border-b-0">
                    <span className="truncate font-medium">{text || `#${index + 1}`}</span>
                    <span className="truncate text-muted-foreground">{file.rows[0]?.[index] ?? ""}</span>
                    <Select value={mapping[index] || SKIP} onValueChange={(name) => mapColumn(index, name === SKIP ? null : name)}>
                      <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value={SKIP}>{__("Don't import")}</SelectItem>
                        {fields.map((f) => <SelectItem key={f.name} value={f.name}>{__(f.label)}{f.required ? " *" : ""}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </div>
            </div>

            {missing.length > 0 && mode === "insert" && (
              <p className="text-xs text-muted-foreground">
                {__("Required fields without a column: {0}. New records need them unless they have a default.", [missing.map((f) => __(f.label)).join(", ")])}
              </p>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Select value={mode} onValueChange={(next) => { setMode(next); setResult(null); }}>
                <SelectTrigger className="h-9 w-72"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="insert">{__("Create new records")}</SelectItem>
                  <SelectItem value="upsert">{__("Create, and update the ones whose Name exists")}</SelectItem>
                </SelectContent>
              </Select>
              <div className="flex-1" />
              <Button type="button" variant="outline" className="h-9" disabled={!mapped.length || !!busy} onClick={() => send(true)}>
                {busy === "validate" && <Loader2 className="mr-1 size-4 animate-spin" />}
                {__("Validate")}
              </Button>
              <Button type="button" className="h-9" disabled={!mapped.length || !!busy || done} onClick={() => send(false)}>
                {busy === "import" && <Loader2 className="mr-1 size-4 animate-spin" />}
                {__("Import")}
              </Button>
            </div>
          </>
        )}

        {result && (
          <div className="rounded-md border p-3 text-sm">
            <div className="font-medium">
              {result.dry_run ? __("Validation (nothing was written)") : __("Import finished")}
            </div>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 tabular-nums text-muted-foreground">
              <span>{result.dry_run ? __("Would create: {0}", [result.created]) : __("Created: {0}", [result.created])}</span>
              <span>{result.dry_run ? __("Would update: {0}", [result.updated]) : __("Updated: {0}", [result.updated])}</span>
              <span className={result.failed ? "text-destructive" : ""}>{__("With errors: {0}", [result.failed])}</span>
            </div>
            {result.issues?.length > 0 && (
              <>
                <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto border-t pt-2 text-xs">
                  {result.issues.map((i) => (
                    <li key={i.row}><span className="font-medium tabular-nums">{__("Row {0}", [i.row])}:</span> {i.message}</li>
                  ))}
                </ul>
                {result.failed > result.issues.length && (
                  <p className="mt-1 text-xs text-muted-foreground">{__("Showing the first {0} errors.", [result.issues.length])}</p>
                )}
                <Button type="button" variant="ghost" className="mt-2 h-8 gap-1 px-2" onClick={downloadFailed}>
                  <DownloadIcon className="size-4" />
                  {__("Download the rows with errors")}
                </Button>
              </>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
