import { useEffect, useMemo, useState } from "react";
import { Popover, PopoverTrigger, PopoverContent } from "@cn/components/ui/popover";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@cn/components/ui/select";
import { Input } from "@cn/components/ui/input";
import { Button } from "@cn/components/ui/button";
import { Checkbox } from "@cn/components/ui/checkbox";
import { ListFilterIcon, PlusIcon, XIcon } from "lucide-react";
import { useWorkspace } from "@workspace/workspace-provider";
import { parseFilterKey, filterKey, OPS_BY_KIND, RANGE_SEPARATOR } from "@global/list-filters";
import { parseOptionLines } from "@global/select-options";
import { __ } from "@global/i18n";
import { useTable } from "./TableContext";
import { listFields, isDateKind } from "./list-fields";
import { queryOf, urlWith, sameUrl } from "./list-url";

// Labels are functions: translated on render, in the page's language.
const OP_LABEL = {
  eq: () => __("is"),
  ne: () => __("is not"),
  gt: () => __("greater than"),
  gte: () => __("at least"),
  lt: () => __("less than"),
  lte: () => __("at most"),
  between: () => __("between"),
  in: () => __("is any of"),
  nin: () => __("is none of"),
  like: () => __("contains"),
  nlike: () => __("does not contain"),
  empty: () => __("is empty"),
  filled: () => __("is not empty"),
};
const DATE_OP_LABEL = {
  gt: () => __("after"),
  gte: () => __("on or after"),
  lt: () => __("before"),
  lte: () => __("on or before"),
};
const opLabel = (op, kind) => ((isDateKind(kind) && DATE_OP_LABEL[op]) || OP_LABEL[op])();

const inputType = (kind) => (isDateKind(kind) ? "date" : kind === "number" ? "number" : "text");

/** Options of a field with inline choices (select / radio), or null. */
function optionsOf(field) {
  if (!field || !["select", "radio_group"].includes(field.element) || typeof field.data?.options !== "string") return null;
  const options = parseOptionLines(field.data.options).filter((o) => o.value !== "" && o.value != null);
  return options.length ? options : null;
}

let nextId = 0;
const newRow = (field) => ({ id: ++nextId, field: field.name, op: OPS_BY_KIND[field.kind][0], value: "", to: "" });

/** The URL's filters with an operator, as editable rows. */
function rowsFromUrl(url, byName) {
  const rows = [];
  for (const [key, raw] of queryOf(url)) {
    const { field, op } = parseFilterKey(key);
    const meta = op && byName[field];
    if (!meta || !OPS_BY_KIND[meta.kind].includes(op)) continue;
    const row = { id: ++nextId, field, op, value: raw, to: "" };
    if (op === "between") {
      const at = raw.indexOf(RANGE_SEPARATOR);
      row.value = at < 0 ? raw : raw.slice(0, at);
      row.to = at < 0 ? "" : raw.slice(at + RANGE_SEPARATOR.length);
    }
    rows.push(row);
  }
  return rows;
}

/** A row as it travels in the URL (`[key, value]`), or null while it is incomplete. */
function rowToParam(row) {
  const key = filterKey(row.field, row.op);
  if (row.op === "empty" || row.op === "filled") return [key, "1"];
  if (row.op === "between") {
    const from = String(row.value ?? "").trim(), to = String(row.to ?? "").trim();
    return from || to ? [key, `${from}${RANGE_SEPARATOR}${to}`] : null;
  }
  const value = String(row.value ?? "").trim();
  return value ? [key, value] : null;
}

const selectClass = "h-9";

function ValueEditor({ row, field, onChange }) {
  const options = optionsOf(field);
  const set = (patch) => onChange({ ...row, ...patch });

  if (row.op === "empty" || row.op === "filled") return null;

  if (field.kind === "bool") {
    return (
      <Select value={["1", "true"].includes(String(row.value)) ? "1" : "0"} onValueChange={(value) => set({ value })}>
        <SelectTrigger className={selectClass}><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="1">{__("Yes")}</SelectItem>
          <SelectItem value="0">{__("No")}</SelectItem>
        </SelectContent>
      </Select>
    );
  }

  if (row.op === "between") {
    return (
      <div className="flex items-center gap-1">
        <Input className="h-9" type={inputType(field.kind)} value={row.value} onChange={(e) => set({ value: e.target.value })} aria-label={__("From")} />
        <span className="text-xs text-muted-foreground">–</span>
        <Input className="h-9" type={inputType(field.kind)} value={row.to} onChange={(e) => set({ to: e.target.value })} aria-label={__("To")} />
      </div>
    );
  }

  if (row.op === "in" || row.op === "nin") {
    if (!options) {
      return <Input className="h-9" value={row.value} placeholder={__("Values separated by commas")} onChange={(e) => set({ value: e.target.value })} />;
    }
    const picked = String(row.value || "").split(",").map((v) => v.trim()).filter(Boolean);
    const toggle = (value, checked) => set({ value: (checked ? [...picked, value] : picked.filter((v) => v !== value)).join(",") });
    return (
      <div className="flex max-h-32 flex-col gap-1.5 overflow-y-auto rounded-md border p-2">
        {options.map((o) => (
          <label key={o.value} className="flex items-center gap-2 text-sm">
            <Checkbox checked={picked.includes(String(o.value))} onCheckedChange={(checked) => toggle(String(o.value), !!checked)} />
            <span className="truncate">{__(o.label ?? o.value)}</span>
          </label>
        ))}
      </div>
    );
  }

  if (options && (row.op === "eq" || row.op === "ne")) {
    return (
      <Select value={row.value || undefined} onValueChange={(value) => set({ value })}>
        <SelectTrigger className={selectClass}><SelectValue placeholder={__("Select…")} /></SelectTrigger>
        <SelectContent>
          {options.map((o) => <SelectItem key={o.value} value={String(o.value)}>{__(o.label ?? o.value)}</SelectItem>)}
        </SelectContent>
      </Select>
    );
  }

  return <Input className="h-9" type={inputType(field.kind)} value={row.value} onChange={(e) => set({ value: e.target.value })} />;
}

/**
 * Filters with an operator (global/list-filters.js) of the list: a funnel
 * button with the number of active ones and a panel to edit them — field,
 * operator, value. They live in the URL next to the search form's filters
 * (`?total.gte=1000&due_date.between=2026-11-01..2026-11-30`), so every view
 * of the list applies them.
 */
export function ListFilters() {
  const { Document, baseColumns } = useTable();
  const { pathname: currentUrl, navigate, award } = useWorkspace();
  const [open, setOpen] = useState(false);

  const fields = useMemo(
    () => listFields(baseColumns(), { recordDates: !!Document?.record_dates }),
    [baseColumns, Document?.record_dates]
  );
  const byName = useMemo(() => Object.fromEntries(fields.map((f) => [f.name, f])), [fields]);

  const active = useMemo(() => rowsFromUrl(currentUrl, byName), [currentUrl, byName]);
  const [rows, setRows] = useState(active);

  // Opening the panel (or the URL changing under it) shows what is applied.
  const applied = JSON.stringify(active.map(rowToParam));
  useEffect(() => { setRows(active.length ? active : []); }, [applied, open]);

  if (!fields.length || !award(Document?.Entity?.name, "search")) return null;

  const update = (next) => setRows((list) => list.map((r) => (r.id === next.id ? next : r)));

  const changeField = (row, name) => {
    const field = byName[name];
    update({ ...row, field: name, op: OPS_BY_KIND[field.kind].includes(row.op) ? row.op : OPS_BY_KIND[field.kind][0], value: "", to: "" });
  };

  const apply = (list) => {
    const next = urlWith(currentUrl, (params) => {
      // Operator filters are replaced as a whole; the search form's bare ones stay.
      for (const key of [...params.keys()]) {
        const { field, op } = parseFilterKey(key);
        if (op && byName[field]) params.delete(key);
      }
      for (const row of list) {
        const param = rowToParam(row);
        if (param) params.set(param[0], param[1]);
      }
      params.delete("page");
    });
    if (!sameUrl(next, currentUrl)) navigate(next);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={__("Filters")}
          aria-label={__("Filters")}
          className="relative inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-input bg-background text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ListFilterIcon className="h-4 w-4" />
          {active.length > 0 && (
            <span className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium leading-none text-primary-foreground">
              {active.length}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(34rem,calc(100vw-2rem))] p-3">
        <div className="mb-2 text-sm font-medium">{__("Filters")}</div>

        {rows.length === 0 && (
          <p className="mb-3 text-sm text-muted-foreground">{__("No filters. Add one to narrow the list.")}</p>
        )}

        <div className="flex flex-col gap-2">
          {rows.map((row) => {
            const field = byName[row.field];
            if (!field) return null;
            return (
              <div key={row.id} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-start gap-2 sm:grid-cols-[minmax(0,10rem)_minmax(0,9rem)_minmax(0,1fr)_auto]">
                <Select value={row.field} onValueChange={(name) => changeField(row, name)}>
                  <SelectTrigger className={selectClass}><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {fields.map((f) => <SelectItem key={f.name} value={f.name}>{__(f.label)}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Select value={row.op} onValueChange={(op) => update({ ...row, op })}>
                  <SelectTrigger className={selectClass}><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {OPS_BY_KIND[field.kind].map((op) => <SelectItem key={op} value={op}>{opLabel(op, field.kind)}</SelectItem>)}
                  </SelectContent>
                </Select>
                <div className="min-w-0 max-sm:order-last max-sm:col-span-3">
                  <ValueEditor row={row} field={field} onChange={update} />
                </div>
                <Button
                  type="button" variant="ghost" className="h-9 w-9 p-0 text-muted-foreground"
                  title={__("Remove filter")} aria-label={__("Remove filter")}
                  onClick={() => setRows((list) => list.filter((r) => r.id !== row.id))}
                >
                  <XIcon className="h-4 w-4" />
                </Button>
              </div>
            );
          })}
        </div>

        <div className="mt-3 flex items-center gap-2">
          <Button type="button" variant="outline" className="h-9" onClick={() => setRows((list) => [...list, newRow(fields[0])])}>
            <PlusIcon className="mr-1 h-4 w-4" />
            {__("Add filter")}
          </Button>
          <div className="flex-1" />
          {active.length > 0 && (
            <Button type="button" variant="ghost" className="h-9" onClick={() => apply([])}>{__("Clear")}</Button>
          )}
          <Button type="button" className="h-9" onClick={() => apply(rows)}>{__("Apply")}</Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
