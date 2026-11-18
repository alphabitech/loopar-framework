import { useMemo, useState } from "react";
import loopar from "loopar";
import { Loader2, PencilLineIcon } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@cn/components/ui/dialog";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@cn/components/ui/select";
import { Input } from "@cn/components/ui/input";
import { Button } from "@cn/components/ui/button";
import { useWorkspace } from "@workspace/workspace-provider";
import { isImportableField } from "@global/list-import";
import { filterKind } from "@global/list-filters";
import { parseOptionLines } from "@global/select-options";
import { __ } from "@global/i18n";
import { useTable } from "./TableContext";

/**
 * Bulk actions on the selected records (core/document/list-bulk.js): set one
 * field to the same value on all of them (`{Entity}/bulkUpdate`) or, on
 * entities with a workflow, run one of its actions (`{Entity}/bulkTransition`).
 * Records fail on their own; the rest are done.
 */
export function BulkEditDialog({ open, onOpenChange }) {
  const { Document, baseColumns, selectedRows } = useTable();
  const { refresh, award } = useWorkspace();
  const entity = Document?.Entity?.name;

  const fields = useMemo(() => {
    const seen = new Set();
    return baseColumns()
      .filter((el) => el?.data?.name && el.data.name !== "name" && !el.isCustom && el.data.write_policy !== "create_only"
        && isImportableField(el) && !seen.has(el.data.name) && seen.add(el.data.name))
      .map((el) => ({ name: el.data.name, label: el.data.label || el.data.name, element: el.element, kind: filterKind(el), data: el.data }));
  }, [baseColumns]);

  // Workflow actions that need nothing else from the user.
  const actions = useMemo(() => {
    const seen = new Set();
    return (Document?.workflow?.board || [])
      .filter((t) => t.action && !(t.required_fields || []).length && !seen.has(t.action) && seen.add(t.action))
      .map((t) => t.action);
  }, [Document?.workflow]);

  const canUpdate = fields.length > 0 && !!award(entity, "update");
  const canTransition = actions.length > 0 && !!award(entity, "transition");

  const [field, setField] = useState("");
  const [value, setValue] = useState("");
  const [action, setAction] = useState("");
  const [busy, setBusy] = useState(null);
  const [result, setResult] = useState(null);
  const [issue, setIssue] = useState(null);

  const meta = fields.find((f) => f.name === field);
  const options = meta && ["select", "radio_group"].includes(meta.element) && typeof meta.data.options === "string"
    ? parseOptionLines(meta.data.options).filter((o) => o.value !== "")
    : null;

  const run = async (kind, body) => {
    setBusy(kind);
    setIssue(null);
    setResult(null);
    try {
      const response = await loopar.call(entity, kind, { body: { names: selectedRows, ...body }, freeze: false, notifyError: false });
      setResult(response);
      if (response.done) refresh();
    } catch (e) {
      setIssue(e?.message || __("The action could not be done."));
    } finally {
      setBusy(null);
    }
  };

  const valueReady = meta && (meta.kind === "bool" ? value !== "" : String(value).trim() !== "");

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) { setResult(null); setIssue(null); } onOpenChange(next); }}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><PencilLineIcon className="size-4" />{__("Edit {0} selected", [selectedRows.length])}</DialogTitle>
          <DialogDescription>{__("The change is applied to each selected record, as if it were edited in its form.")}</DialogDescription>
        </DialogHeader>

        {canUpdate && (
          <div className="flex flex-col gap-2 rounded-md border p-3">
            <div className="text-sm font-medium">{__("Set a field")}</div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Select value={field || undefined} onValueChange={(name) => { setField(name); setValue(""); }}>
                <SelectTrigger className="h-9"><SelectValue placeholder={__("Field")} /></SelectTrigger>
                <SelectContent>
                  {fields.map((f) => <SelectItem key={f.name} value={f.name}>{__(f.label)}</SelectItem>)}
                </SelectContent>
              </Select>

              {!meta ? <div /> : meta.kind === "bool" ? (
                <Select value={value || undefined} onValueChange={setValue}>
                  <SelectTrigger className="h-9"><SelectValue placeholder={__("Value")} /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">{__("Yes")}</SelectItem>
                    <SelectItem value="0">{__("No")}</SelectItem>
                  </SelectContent>
                </Select>
              ) : options ? (
                <Select value={value || undefined} onValueChange={setValue}>
                  <SelectTrigger className="h-9"><SelectValue placeholder={__("Value")} /></SelectTrigger>
                  <SelectContent>
                    {options.map((o) => <SelectItem key={o.value} value={String(o.value)}>{__(o.label ?? o.value)}</SelectItem>)}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  className="h-9"
                  type={meta.kind === "date" ? "date" : meta.kind === "number" ? "number" : "text"}
                  value={value}
                  placeholder={meta.element === "connection" ? __("Name or title of the record") : __("Value")}
                  onChange={(e) => setValue(e.target.value)}
                />
              )}
            </div>
            <div className="flex justify-end">
              <Button type="button" className="h-9" disabled={!valueReady || !!busy} onClick={() => run("bulkUpdate", { field, value })}>
                {busy === "bulkUpdate" && <Loader2 className="mr-1 size-4 animate-spin" />}
                {__("Apply to {0} records", [selectedRows.length])}
              </Button>
            </div>
          </div>
        )}

        {canTransition && (
          <div className="flex flex-col gap-2 rounded-md border p-3">
            <div className="text-sm font-medium">{__("Change state")}</div>
            <div className="flex items-center gap-2">
              <Select value={action || undefined} onValueChange={setAction}>
                <SelectTrigger className="h-9 flex-1"><SelectValue placeholder={__("Action")} /></SelectTrigger>
                <SelectContent>
                  {actions.map((name) => <SelectItem key={name} value={name}>{__(name)}</SelectItem>)}
                </SelectContent>
              </Select>
              <Button type="button" className="h-9" disabled={!action || !!busy} onClick={() => run("bulkTransition", { action })}>
                {busy === "bulkTransition" && <Loader2 className="mr-1 size-4 animate-spin" />}
                {__("Run")}
              </Button>
            </div>
          </div>
        )}

        {!canUpdate && !canTransition && (
          <p className="text-sm text-muted-foreground">{__("There is nothing you can change in bulk on this list.")}</p>
        )}

        {issue && <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">{issue}</p>}

        {result && (
          <div className="rounded-md border p-3 text-sm">
            <div className="flex flex-wrap gap-x-4 tabular-nums">
              <span>{__("Done: {0}", [result.done])}</span>
              <span className={result.failed ? "text-destructive" : "text-muted-foreground"}>{__("With errors: {0}", [result.failed])}</span>
            </div>
            {result.issues?.length > 0 && (
              <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto border-t pt-2 text-xs">
                {result.issues.map((i, index) => <li key={index}><span className="font-medium">{i.name}:</span> {i.message}</li>)}
              </ul>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
