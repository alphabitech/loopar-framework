import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import loopar from "loopar";
import fileManager from "@@file/file-manager";
// Lazy: this module sits under base-input (read-only fields), so it is on
// every form; the markdown renderer loads only when a value needs it.
const MarkdownPreview = lazy(() => import("../../components/markdown/preview.jsx"));
import { elementsDict } from "@global/element-definition";
import { useDocument } from "../base/provider";
import { printKind, formatPrintValue, isEmptyValue, isNumericKind, DEFAULT_LOCALE } from "./format-value";

const SECTION_ELEMENTS = new Set(["tab", "section", "panel", "card"]);

const isTrue = (v) => loopar.utils.trueValue(v);
const isWritable = (element) => elementsDict[element]?.def?.isWritable === true || element === "metadata";
const isHidden = (data = {}) => isTrue(data.hidden) || isTrue(data.print_hide);

const parseJSON = (value, fallback) => {
  if (Array.isArray(value) || (value && typeof value === "object")) return value;
  return loopar.utils.JSONparse(value, fallback);
};

function PrintImages({ value }) {
  const files = (fileManager.getMappedFiles(value) || []).filter((f) => f?.src);
  if (!files.length) return null;
  return (
    <div className="lp-images">
      {files.map((f, i) => <img key={f.src + i} src={f.src} alt={f.name || ""} />)}
    </div>
  );
}

function PrintFiles({ value }) {
  const files = (fileManager.getMappedFiles(value) || []).filter(Boolean);
  if (!files.length) return null;
  // Linked: on screen the file opens (private files check access on the server).
  return (
    <span>
      {files.map((f, i) => (
        <span key={(f.src || f.name) + i}>
          {i > 0 && ", "}
          {f.src ? <a href={f.src} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">{f.name || f.src}</a> : f.name}
        </span>
      ))}
    </span>
  );
}

function PrintKeyValue({ value }) {
  const rows = (parseJSON(value, []) || []).filter((r) => r && (r.name ?? r.label) != null);
  if (!rows.length) return null;
  return (
    <dl className="lp-keyvalue">
      {rows.map((r, i) => (
        <div key={i}>
          <dt>{String(r.name ?? r.label)}</dt>
          <dd>{r.value != null ? String(r.value) : ""}</dd>
        </div>
      ))}
    </dl>
  );
}

export function PrintValue({ element, data = {}, value }) {
  const { Document } = useDocument();
  const kind = printKind(element, data);
  if (kind === "skip") return null;
  if (kind === "images") return isEmptyValue(value) ? null : <PrintImages value={value} />;
  if (kind === "files") return isEmptyValue(value) ? null : <PrintFiles value={value} />;
  if (kind === "keyvalue") return isEmptyValue(value) ? null : <PrintKeyValue value={value} />;
  if (kind === "markdown") {
    return isEmptyValue(value) ? null : (
      <div className="lp-markdown">
        <Suspense fallback={<div className="whitespace-pre-wrap">{String(value)}</div>}>
          <MarkdownPreview source={String(value)} />
        </Suspense>
      </div>
    );
  }

  const text = formatPrintValue(kind, value, { data, titles: Document?.linkTitles });
  if (text == null) return null;
  return <span className={isNumericKind(kind) ? "lp-num" : undefined}>{text}</span>;
}

function childColumns(el, names = null) {
  const structure = parseJSON(el.__META__?.Entity?.doc_structure, []) || [];
  const fields = [];
  const walk = (nodes) => nodes.forEach((n) => {
    if (!n?.element) return;
    if (isWritable(n.element)) {
      const kind = printKind(n.element, n.data);
      if (n.data?.name && !isHidden(n.data) && !["skip", "table", "images", "files", "keyvalue", "markdown"].includes(kind)) {
        fields.push({ element: n.element, data: n.data, kind });
      }
    } else if (n.elements) {
      walk(n.elements);
    }
  });
  walk(structure);

  if (names?.length) {
    const byName = new Map(fields.map((f) => [f.data.name, f]));
    return names.map((n) => byName.get(n)).filter(Boolean);
  }

  const listed = fields.filter((f) => isTrue(f.data.in_list_view));
  return listed.length ? listed : fields;
}

export function PrintTable({ el, value, columns: names = null }) {
  const { Document } = useDocument();
  const titles = Document?.linkTitles;
  const rows = parseJSON(value, []) || [];
  const namesKey = names ? names.join(",") : "";
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const columns = useMemo(() => childColumns(el, names), [el, namesKey]);
  if (!rows.length || !columns.length) return null;

  return (
    <table className="lp-table">
      <thead>
        <tr>
          {columns.map((c) => (
            <th key={c.data.name} className={isNumericKind(c.kind) ? "lp-num" : undefined}>
              {c.data.label || loopar.utils.Capitalize(c.data.name)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={row.name ?? row.id ?? i}>
            {columns.map((c) => (
              <td key={c.data.name} className={isNumericKind(c.kind) ? "lp-num" : undefined}>
                {formatPrintValue(c.kind, row[c.data.name], { data: c.data, titles }) ?? ""}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function hasContent(el, values) {
  if (!el?.element || isHidden(el.data)) return false;
  if (isWritable(el.element)) {
    const kind = printKind(el.element, el.data);
    if (kind === "skip") return false;
    const value = values[el.data?.name];
    if (kind === "bool") return value !== undefined && value !== null;
    if (kind === "table") return (parseJSON(value, []) || []).length > 0;
    return !isEmptyValue(value);
  }
  return (el.elements || []).some((child) => hasContent(child, values));
}

function Field({ el, value }) {
  const { element, data = {} } = el;

  if (element === "form_table") {
    return (
      <div className="lp-block">
        {data.label && <div className="lp-label">{data.label}</div>}
        <PrintTable el={el} value={value} />
      </div>
    );
  }

  const rendered = <PrintValue element={element} data={data} value={value} />;
  const wide = ["textarea", "markdown_input", "metadata", "image_input"].includes(element);

  return (
    <div className={wide ? "lp-field lp-wide" : "lp-field"}>
      <div className="lp-label">{data.label || loopar.utils.Capitalize(data.name || "")}</div>
      <div className={element === "textarea" ? "lp-value lp-multiline" : "lp-value"}>{rendered}</div>
    </div>
  );
}

function Node({ el, values }) {
  if (!hasContent(el, values)) return null;
  const { element, data = {} } = el;

  if (isWritable(element)) return <Field el={el} value={values[data.name]} />;

  const children = (el.elements || []).filter((child) => hasContent(child, values));
  const body = children.map((child, i) => <Node key={child.data?.key ?? child.data?.name ?? i} el={child} values={values} />);

  if (element === "row") {
    return (
      <div className="lp-row" style={{ "--lp-cols": Math.max(children.length, 1) }}>
        {body}
      </div>
    );
  }

  if (SECTION_ELEMENTS.has(element) && data.label) {
    return (
      <section className="lp-section">
        <h3 className="lp-section-title">{data.label}</h3>
        <div className="lp-stack">{body}</div>
      </section>
    );
  }

  return <div className="lp-stack">{body}</div>;
}

export function PrintStructure({ ctrl: ctrlProp }) {
  const { ctrl: ctx } = useDocument();
  const ctrl = ctrlProp || ctx;
  const values = ctrl?.Document?.data || {};
  const structure = ctrl?.__STRUCTURE__ || [];

  return (
    <div className="lp-stack">
      {structure.map((el, i) => <Node key={el.data?.key ?? el.data?.name ?? i} el={el} values={values} />)}
    </div>
  );
}

export function PrintHeader({ title, subtitle, children }) {
  const { Document = {} } = useDocument();
  const entity = Document.Entity?.name;
  // Client-only: "today" on the server may not be today in the browser (hydration).
  const [date, setDate] = useState("");
  useEffect(() => {
    setDate(new Date().toLocaleDateString(DEFAULT_LOCALE, { year: "numeric", month: "short", day: "2-digit" }));
  }, []);

  return (
    <header className="lp-header">
      <div>
        <div className="lp-title">{title ?? entity}</div>
        {(subtitle ?? Document.name) && <div className="lp-subtitle">{subtitle ?? Document.name}</div>}
      </div>
      <div className="lp-header-aside">
        {children ?? <span>{date}</span>}
      </div>
    </header>
  );
}
