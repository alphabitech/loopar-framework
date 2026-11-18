import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import loopar, { useRealtime } from "loopar";
import { ArrowDownIcon, ArrowUpIcon, DownloadIcon, Loader2, PrinterIcon, SigmaIcon } from "lucide-react";
import { Link } from "@link";
import { Button } from "@cn/components/ui/button";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@cn/components/ui/select";
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@cn/components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableFooter, TableHeader, TableRow } from "@cn/components/ui/table";
import { cn } from "@cn/lib/utils";
import { useWorkspace } from "@workspace/workspace-provider";
import { useViewOptions } from "@loopar/document";
import { useTable } from "@@table/TableContext";
import { TableSearch } from "@@table/TableSearch";
import { ListFilters } from "@@table/ListFilters";
import { listFields, groupableFields, summableFields, isDateKind } from "@@table/list-fields";
import { queryOf, urlWith, downloadText } from "@@table/list-url";
import {
  parseReportSpec, formatReportSpec, reportValueKey,
  REPORT_PARAMS, REPORT_CHART_PARAM, REPORT_FUNCTIONS, REPORT_CHARTS, MAX_REPORT_VALUES, DEFAULT_GRAIN,
} from "@global/list-report";
import { BUCKET_GRAINS, bucketDays } from "@global/date-buckets";
import { parseFilterKey, filterKey, RANGE_SEPARATOR } from "@global/list-filters";
import { toCsv, csvFileName } from "@global/csv";
import { formatNumber, formatCurrency, regional, safeLocale } from "@global/format";
import { __ } from "@global/i18n";

/**
 * Report view of a list: its records grouped by one or two fields, counted,
 * with numeric fields aggregated, a chart and the totals. The report is in
 * the URL next to the list's filters (global/list-report.js), so it can be
 * shared; its data comes from `{Entity}/report`. A group's count leads to
 * the records behind it. Print puts the chart and the table on a print sheet
 * (document/print/print.css): paper, or the browser's "Save as PDF".
 */

const ReportChart = lazy(() => import("./report-chart"));

const NONE = "__none__";
const CHART_POINTS = 40;

// Labels are functions: translated on render, in the page's language.
const GRAIN_LABEL = {
  day: () => __("Day"), week: () => __("Week"), month: () => __("Month"), quarter: () => __("Quarter"), year: () => __("Year"),
};
const FN_LABEL = {
  sum: (field) => __("Sum of {0}", [field]),
  avg: (field) => __("Average of {0}", [field]),
  min: (field) => __("Min of {0}", [field]),
  max: (field) => __("Max of {0}", [field]),
};
const FN_SHORT = { sum: () => __("Sum"), avg: () => __("Average"), min: () => __("Min"), max: () => __("Max") };
const CHART_LABEL = {
  bar: () => __("Bars"), line: () => __("Line"), area: () => __("Area"), donut: () => __("Donut"), none: () => __("No chart"),
};

const Spinner = () => (
  <div className="flex justify-center py-16"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>
);

/** A time bucket (global/date-buckets.js) as people read it. */
function bucketLabel(key, grain) {
  const locale = safeLocale(regional().locale);
  const text = (day, options) => new Intl.DateTimeFormat(locale, { timeZone: "UTC", ...options }).format(new Date(`${day}T00:00:00Z`));
  try {
    if (grain === "year") return key;
    if (grain === "quarter") { const [year, quarter] = key.split("-Q"); return `Q${quarter} ${year}`; }
    if (grain === "month") return text(`${key}-01`, { month: "short", year: "numeric" });
    if (grain === "week") return __("Week of {0}", [text(key, { month: "short", day: "numeric", year: "numeric" })]);
    return text(key, { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return key;
  }
}

/** What a group key reads as: its label, its time bucket, or the key itself; null when empty. */
function groupText(group, key, label) {
  if (key === "" || key === null || key === undefined) return null;
  if (label !== null && label !== undefined && label !== "") return String(label);
  return group.grain ? bucketLabel(key, group.grain) : String(key);
}

const formatValue = (value, format) => {
  if (value === null || value === undefined) return "—";
  return format === "currency" ? formatCurrency(value) : formatNumber(value, { maximumFractionDigits: 2 });
};

/** The list filter that selects the records of one group. */
function groupFilter(group, key) {
  if (key === "") return [filterKey(group.field, "empty"), "1"];
  if (group.grain) {
    const days = bucketDays(key, group.grain);
    return days ? [filterKey(group.field, "between"), days.join(RANGE_SEPARATOR)] : null;
  }
  return [filterKey(group.field, "eq"), key];
}

function FieldSelect({ value, fields, onChange, noneLabel, label }) {
  return (
    <Select value={value || NONE} onValueChange={(next) => onChange(next === NONE ? null : next)}>
      <SelectTrigger className="h-9 w-44" aria-label={label}><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>{noneLabel}</SelectItem>
        {fields.map((f) => <SelectItem key={f.name} value={f.name}>{__(f.label)}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

function GrainSelect({ value, onChange }) {
  return (
    <Select value={value || DEFAULT_GRAIN} onValueChange={onChange}>
      <SelectTrigger className="h-9 w-28" aria-label={__("Group dates by")}><SelectValue /></SelectTrigger>
      <SelectContent>
        {BUCKET_GRAINS.map((grain) => <SelectItem key={grain} value={grain}>{GRAIN_LABEL[grain]()}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

export function ReportView({ ctrl }) {
  const Document = ctrl.Document;
  const entity = Document.Entity?.name;
  const { pathname: currentUrl, navigate } = useWorkspace();
  const { baseColumns, search } = useTable();
  const { hasSearchForm = true } = useViewOptions();

  const fields = useMemo(
    () => listFields(baseColumns(), { recordDates: !!Document.record_dates }),
    [baseColumns, Document.record_dates]
  );
  const byName = useMemo(() => Object.fromEntries(fields.map((f) => [f.name, f])), [fields]);
  const groupable = useMemo(() => groupableFields(fields), [fields]);
  const summable = useMemo(() => summableFields(fields), [fields]);

  const spec = useMemo(
    () => parseReportSpec(Object.fromEntries(queryOf(currentUrl))) || { groups: [], values: [], chart: "bar" },
    [currentUrl]
  );

  // What the data depends on: the filters and the report, not the page, the sort or the chart type.
  const dataQuery = useMemo(() => {
    const params = queryOf(currentUrl);
    ["page", "sort", "preloaded", "workspace", REPORT_CHART_PARAM].forEach((key) => params.delete(key));
    return params.toString();
  }, [currentUrl]);

  const [state, setState] = useState({ loading: true, data: null, issue: null });
  const [tick, setTick] = useState(0);
  const [order, setOrder] = useState(null);
  // The chart loads in the browser only.
  const [client, setClient] = useState(false);
  useEffect(() => setClient(true), []);

  useRealtime(`${entity}.changed`, () => setTick((n) => n + 1));

  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    loopar.call(entity, "report", { query: Object.fromEntries(new URLSearchParams(dataQuery)), freeze: false, notifyError: false })
      .then((data) => alive && setState({ loading: false, data: data || null, issue: null }))
      .catch((e) => alive && setState({ loading: false, data: null, issue: e?.message || __("The report could not be loaded.") }));
    return () => { alive = false; };
  }, [entity, dataQuery, tick]);

  useEffect(() => setOrder(null), [dataQuery]);

  // Printing: the report becomes a print sheet (light, no controls) while the
  // browser's print dialog is open.
  const [printing, setPrinting] = useState(false);
  useEffect(() => {
    if (!printing) return;
    const done = () => setPrinting(false);
    window.addEventListener("afterprint", done);
    // Let the sheet (and the chart at its new width) paint first.
    const timer = setTimeout(() => window.print(), 500);
    return () => { clearTimeout(timer); window.removeEventListener("afterprint", done); };
  }, [printing]);

  /** The filters the report was run with, as the URL writes them: the print sheet says what it shows. */
  const filterText = useMemo(() => {
    const params = queryOf(currentUrl);
    ["page", "sort", "preloaded", "workspace", ...REPORT_PARAMS].forEach((key) => params.delete(key));
    return [...params].map(([key, value]) => {
      const { field, op } = parseFilterKey(key);
      return `${__(byName[field]?.label || field)}${op ? ` (${op})` : ""}: ${value}`;
    }).join(" · ");
  }, [currentUrl, byName]);

  const setSpec = (next) => {
    navigate(urlWith(currentUrl, (params) => {
      REPORT_PARAMS.forEach((key) => params.delete(key));
      Object.entries(formatReportSpec(next)).forEach(([key, value]) => params.set(key, value));
      params.delete("page");
    }), { replace: true });
  };

  const setGroup = (index, name) => {
    const groups = spec.groups.slice(0, index);
    if (name) groups.push({ field: name, grain: isDateKind(byName[name]?.kind) ? (spec.groups[index]?.grain || DEFAULT_GRAIN) : null });
    // A second level stays while it still differs from the first.
    if (index === 0 && name && spec.groups[1] && spec.groups[1].field !== name) groups.push(spec.groups[1]);
    setSpec({ ...spec, groups });
  };

  const setGrain = (index, grain) => {
    setSpec({ ...spec, groups: spec.groups.map((g, i) => (i === index ? { ...g, grain } : g)) });
  };

  const toggleValue = (value, checked) => {
    const key = reportValueKey(value);
    const values = checked
      ? [...spec.values, value].slice(0, MAX_REPORT_VALUES)
      : spec.values.filter((v) => reportValueKey(v) !== key);
    setSpec({ ...spec, values });
  };

  const { data, loading, issue } = state;
  const groups = data?.groups || [];
  const values = data?.values || [];

  const rows = useMemo(() => {
    const list = [...(data?.rows || [])];
    if (!order) return list;
    const read = (row) => (order.key === "count" ? row.count
      : order.key.startsWith("group:") ? row.keys[Number(order.key.slice(6))]
      : row.values?.[order.key]);
    const direction = order.dir === "desc" ? -1 : 1;
    return list.sort((a, b) => {
      const x = read(a), y = read(b);
      if (x === y) return 0;
      // Empty values close the list either way.
      if (x === null || x === undefined || x === "") return 1;
      if (y === null || y === undefined || y === "") return -1;
      const result = typeof x === "number" && typeof y === "number" ? x - y
        : String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: "base" });
      return result * direction;
    });
  }, [data, order]);

  const toggleOrder = (key) => setOrder((current) => (
    current?.key !== key ? { key, dir: key.startsWith("group:") ? "asc" : "desc" }
      : current.dir === "desc" && !key.startsWith("group:") ? { key, dir: "asc" }
      : current.dir === "asc" && key.startsWith("group:") ? { key, dir: "desc" }
      : null
  ));

  const rowLabels = (row) => groups.map((group, i) => groupText(group, row.keys[i], row.labels?.[i]) ?? __("(empty)"));

  /** List of the records behind a group: the report's filters plus the group's. */
  const recordsUrl = (row) => urlWith(currentUrl, (params) => {
    [...REPORT_PARAMS, "page"].forEach((key) => params.delete(key));
    groups.forEach((group, i) => {
      const filter = groupFilter(group, row.keys[i]);
      if (!filter) return;
      for (const key of [...params.keys()]) {
        if (parseFilterKey(key).field === group.field) params.delete(key);
      }
      params.set(filter[0], filter[1]);
    });
  });

  // The chart draws the first value (or the count) of each group.
  const metric = values[0] || null;
  const metricLabel = metric ? FN_LABEL[metric.fn](metric.label) : __("Records");
  const chart = spec.chart !== "none" && groups.length > 0 && rows.length > 0 ? {
    type: spec.chart,
    labels: rows.slice(0, CHART_POINTS).map((row) => rowLabels(row).join(" · ")),
    values: rows.slice(0, CHART_POINTS).map((row) => Number(metric ? row.values?.[metric.key] : row.count) || 0),
  } : null;

  const download = () => {
    const header = [...groups.map((g) => g.label), __("Records"), ...values.map((v) => FN_LABEL[v.fn](v.label))];
    const body = rows.map((row) => [...rowLabels(row), row.count, ...values.map((v) => row.values?.[v.key] ?? "")]);
    const total = groups.length
      ? [[__("Total"), ...groups.slice(1).map(() => ""), data.totals.count, ...values.map((v) => data.totals.values?.[v.key] ?? "")]]
      : [];
    const now = new Date();
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    downloadText(csvFileName(`${entity} report`, day), toCsv([header, ...body, ...total]));
  };

  const HeadButton = ({ sortKey, children, className }) => {
    const active = order?.key === sortKey;
    const Icon = active && order.dir === "asc" ? ArrowUpIcon : ArrowDownIcon;
    return (
      <button type="button" onClick={() => toggleOrder(sortKey)} className={cn("group/sort inline-flex items-center gap-1 hover:text-foreground", active && "text-foreground", className)}>
        <span className="truncate">{children}</span>
        <Icon className={cn("h-3.5 w-3.5 shrink-0", !active && "opacity-0 group-hover/sort:opacity-60")} />
      </button>
    );
  };

  const first = spec.groups[0];
  const second = spec.groups[1];

  return (
    <div className="flex flex-col gap-3">
      {hasSearchForm !== false && (
        <div className="flex items-start gap-2" data-print-hide>
          <div className="min-w-0 flex-1"><TableSearch onChange={search} /></div>
          <ListFilters />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 p-2" data-print-hide>
        <span className="pl-1 text-sm text-muted-foreground">{__("Group by")}</span>
        <FieldSelect value={first?.field} fields={groupable} onChange={(name) => setGroup(0, name)} noneLabel={__("Nothing (totals only)")} label={__("Group by")} />
        {first?.grain && <GrainSelect value={first.grain} onChange={(grain) => setGrain(0, grain)} />}

        {first && (
          <>
            <span className="pl-1 text-sm text-muted-foreground">{__("then by")}</span>
            <FieldSelect value={second?.field} fields={groupable.filter((f) => f.name !== first.field)} onChange={(name) => setGroup(1, name)} noneLabel={__("Nothing")} label={__("Then by")} />
            {second?.grain && <GrainSelect value={second.grain} onChange={(grain) => setGrain(1, grain)} />}
          </>
        )}

        {summable.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="outline" className="h-9 gap-1 px-3">
                <SigmaIcon className="h-4 w-4" />
                {__("Values")}
                {spec.values.length > 0 && <span className="rounded-full bg-muted px-1.5 text-xs tabular-nums">{spec.values.length}</span>}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-96 w-56 overflow-y-auto">
              {summable.map((field, index) => (
                <div key={field.name}>
                  {index > 0 && <DropdownMenuSeparator />}
                  <DropdownMenuLabel>{__(field.label)}</DropdownMenuLabel>
                  {REPORT_FUNCTIONS.map((fn) => {
                    const checked = spec.values.some((v) => v.fn === fn && v.field === field.name);
                    return (
                      <DropdownMenuCheckboxItem
                        key={fn}
                        checked={checked}
                        disabled={!checked && spec.values.length >= MAX_REPORT_VALUES}
                        onCheckedChange={(next) => toggleValue({ fn, field: field.name }, !!next)}
                        // Keep the menu open: several values are usually picked at once.
                        onSelect={(e) => e.preventDefault()}
                      >
                        {FN_SHORT[fn]()}
                      </DropdownMenuCheckboxItem>
                    );
                  })}
                </div>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        <div className="flex-1" />

        {first && (
          <Select value={spec.chart} onValueChange={(chartType) => setSpec({ ...spec, chart: chartType })}>
            <SelectTrigger className="h-9 w-32" aria-label={__("Chart")}><SelectValue /></SelectTrigger>
            <SelectContent>
              {REPORT_CHARTS.map((type) => <SelectItem key={type} value={type}>{CHART_LABEL[type]()}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
        <Button type="button" variant="outline" className="h-9 gap-1 px-3" disabled={!data || loading} onClick={download} title={__("Download this report as CSV")}>
          <DownloadIcon className="h-4 w-4" />
          CSV
        </Button>
        <Button type="button" variant="outline" className="h-9 gap-1 px-3" disabled={!data || loading} onClick={() => setPrinting(true)} title={__("Print this report, or save it as PDF")}>
          <PrinterIcon className="h-4 w-4" />
          {__("Print")}
        </Button>
      </div>

      {issue ? (
        <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">{issue}</div>
      ) : !data ? (
        <Spinner />
      ) : (
        <div
          className={cn("flex flex-col gap-3 transition-opacity", loading && "opacity-60", printing && "lp-print-sheet")}
          data-print-sheet={printing ? "" : undefined}
          // A fixed width that fits Letter and A4 inside the printer's margins:
          // the chart is drawn at the size it prints, and the table fills the sheet
          // (no auto margins: in this column they would shrink the sheet to its content).
          style={printing ? { width: "7in", boxSizing: "content-box" } : undefined}
        >
          {printing && (
            <div>
              <div className="text-lg font-semibold">{__(entity)} — {__("Report")}</div>
              <div className="text-xs text-muted-foreground">
                {[
                  groups.length ? `${__("Group by")}: ${groups.map((g) => g.label + (g.grain ? ` (${GRAIN_LABEL[g.grain]().toLowerCase()})` : "")).join(", ")}` : null,
                  filterText || null,
                  new Intl.DateTimeFormat(safeLocale(regional().locale), { dateStyle: "medium", timeStyle: "short" }).format(new Date()),
                ].filter(Boolean).join(" · ")}
              </div>
            </div>
          )}
          {chart && (
            <div className="rounded-md border p-3">
              <div className="mb-2 text-sm text-muted-foreground">
                {metricLabel}
                {rows.length > CHART_POINTS && ` · ${__("first {0} groups", [CHART_POINTS])}`}
              </div>
              {client ? (
                <Suspense fallback={<Spinner />}>
                  <ReportChart type={chart.type} labels={chart.labels} values={chart.values} />
                </Suspense>
              ) : <Spinner />}
            </div>
          )}

          <div className="border">
            <Table className="w-full">
              <TableHeader className="bg-muted/40">
                <TableRow className="[&>td]:h-10 [&>td]:py-2 [&>td]:text-sm [&>td]:font-medium [&>td]:text-muted-foreground">
                  {groups.map((group, i) => (
                    <TableCell key={group.field}>
                      <HeadButton sortKey={`group:${i}`}>
                        {group.label}{group.grain ? ` (${GRAIN_LABEL[group.grain]().toLowerCase()})` : ""}
                      </HeadButton>
                    </TableCell>
                  ))}
                  <TableCell className="text-right"><HeadButton sortKey="count" className="flex-row-reverse">{__("Records")}</HeadButton></TableCell>
                  {values.map((v) => (
                    <TableCell key={v.key} className="text-right">
                      <HeadButton sortKey={v.key} className="flex-row-reverse">{FN_LABEL[v.fn](v.label)}</HeadButton>
                    </TableCell>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={groups.length + 1 + values.length} className="py-10 text-center text-sm text-muted-foreground">
                      {__("No records match these filters.")}
                    </TableCell>
                  </TableRow>
                ) : rows.map((row) => (
                  <TableRow key={JSON.stringify(row.keys)} className="hover:bg-muted/40">
                    {groups.map((group, i) => {
                      const text = groupText(group, row.keys[i], row.labels?.[i]);
                      return (
                        <TableCell key={group.field} className={cn("py-2 align-middle", i === 0 && "font-medium", text === null && "italic text-muted-foreground")}>
                          {text ?? __("(empty)")}
                        </TableCell>
                      );
                    })}
                    <TableCell className="py-2 text-right align-middle tabular-nums">
                      {groups.length ? (
                        <Link to={recordsUrl(row)} className="p-0 hover:underline" title={__("See these records")}>{formatNumber(row.count)}</Link>
                      ) : formatNumber(row.count)}
                    </TableCell>
                    {values.map((v) => (
                      <TableCell key={v.key} className="py-2 text-right align-middle tabular-nums">{formatValue(row.values?.[v.key], v.format)}</TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
              {groups.length > 0 && rows.length > 0 && (
                <TableFooter>
                  <TableRow>
                    <TableCell colSpan={groups.length} className="py-2 font-semibold">{__("Total")}</TableCell>
                    <TableCell className="py-2 text-right font-semibold tabular-nums">{formatNumber(data.totals.count)}</TableCell>
                    {values.map((v) => (
                      <TableCell key={v.key} className="py-2 text-right font-semibold tabular-nums">{formatValue(data.totals.values?.[v.key], v.format)}</TableCell>
                    ))}
                  </TableRow>
                </TableFooter>
              )}
            </Table>
          </div>

          {data.truncated && (
            <p className="text-xs text-muted-foreground">
              {__("This report has more groups than it can show ({0}). Add filters or group by a wider period to see all of it.", [formatNumber(data.groupCount)])}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
