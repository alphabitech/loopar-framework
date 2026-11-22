'use strict';

import { loopar } from '../loopar.js';
import { fileManage } from '../file-manage.js';
import { getCompany } from '../global/company.js';
import { elementsDict } from '../global/element-definition.js';
import { printKind, formatPrintValue, isEmptyValue } from '../global/print-value.js';

export const STANDARD_FORMAT = "standard";
const PRINT_FORMAT_TYPE = "Print Format";

const truthy = (v) => loopar.utils.trueValue(v);

function readFormat(ref) {
  const cfg = fileManage.getConfigFile(ref.__NAME__, ref.__ROOT__);
  if (!cfg) return null;
  return { ...cfg, name: cfg.name || ref.__NAME__, __APP__: ref.__APP__ };
}

export function listPrintFormats(entity) {
  if (!entity) return [];
  const target = loopar.utils.toEntityKey(entity);

  return Object.values(loopar.getRefs())
    .filter(ref => ref.__TYPE__ === PRINT_FORMAT_TYPE)
    .map(readFormat)
    .filter(f => f && !truthy(f.disabled) && f.for_entity && loopar.utils.toEntityKey(f.for_entity) === target)
    .sort((a, b) => (truthy(b.is_default) - truthy(a.is_default)) || String(a.name).localeCompare(String(b.name)));
}

export function getPrintFormat(name) {
  const ref = name && loopar.getRef(name, false);
  if (!ref || ref.__TYPE__ !== PRINT_FORMAT_TYPE) return null;
  return readFormat(ref);
}

/**
 * Format for this request:
 *   ?format=standard → none (the app's `<entity>-print.jsx` or the automatic format)
 *   ?format=<name> → that format, when it prints this entity
 *   nothing → the entity's default format, if one is marked
 */
export function resolvePrintFormat(formats, requested) {
  if (requested === STANDARD_FORMAT) return null;
  if (requested) return formats.find(f => f.name === requested) || null;
  return formats.find(f => truthy(f.is_default)) || null;
}

/** What a Letterhead adds on top of the company: its own tagline and footer. */
const LETTERHEAD_FIELDS = ["name", "tagline", "footer", "is_default"];

async function findLetterhead(name) {
  if (!loopar.getRef("Letterhead", false)) return null;
  if (name) {
    const row = await loopar.db.getRow("Letterhead", name, LETTERHEAD_FIELDS);
    if (row) return row;
  }
  const [row] = await loopar.db.getAll("Letterhead", LETTERHEAD_FIELDS, { is_default: 1 });
  return row || null;
}

/**
 * Letterhead of a print: the company's identity (Company single) plus the
 * letterhead's tagline and footer (the named one, else the default one).
 * Null only when there is neither a company nor a letterhead.
 */
export async function getLetterhead(name = null) {
  try {
    const [company, letterhead] = await Promise.all([getCompany(), findLetterhead(name)]);
    if (!company?.company_name && !letterhead) return null;
    return {
      ...(letterhead || {}),
      company_name: company?.company_name || "",
      legal_name: company?.legal_name || "",
      tax_id_label: company?.tax_id_label || "",
      tax_id: company?.tax_id || "",
      logo: company?.logo || null,
      address: company?.address_text || "",
      phone: company?.phone || "",
      email: company?.email || "",
      website: company?.website || "",
    };
  } catch (e) {
    console.warn("[print] letterhead unavailable:", e?.message);
    return null;
  }
}

function formatPayload(format) {
  if (!format) return null;
  return {
    name: format.name,
    doc_structure: format.doc_structure,
    paper_size: format.paper_size || null,
    orientation: format.orientation || null,
  };
}

/**
 * `designedOnly` (the portal): only the entity's designed formats — the
 * customer-facing ones —, never the automatic "standard" sheet (every field)
 * while the entity has one; an unknown request falls back to the default.
 */
export async function printPayload(entity, { requested = null, format: forced = null, designedOnly = false } = {}) {
  const formats = listPrintFormats(entity);
  if (designedOnly && formats.length && !formats.some(f => f.name === requested)) requested = null;
  const format = forced || resolvePrintFormat(formats, requested) || (designedOnly ? formats[0] || null : null);

  return {
    format: formatPayload(format),
    formats: formats.map(f => ({ name: f.name, is_default: truthy(f.is_default) ? 1 : 0 })),
    letterhead: await getLetterhead(format?.letterhead),
  };
}

/**
 * A record as its Print Format prints it, frozen: the format, the record's
 * values and labels, the titles of its links and the letterhead, as they are
 * now. The client draws it with <PrintSheet> (the desk's print components);
 * `snapshotHTML()` is the same content as plain HTML. Used where the copy
 * must not follow later changes — a document sent to sign.
 *
 * `format`: a Print Format name; default = the entity's default format.
 * Null when the entity has no format to print with.
 */
export async function printSnapshot(entity, name, { format: requested = null } = {}) {
  const { format, letterhead } = await printPayload(entity, { requested });
  if (!format) return null;

  // A fresh instance: __meta__() reshapes the document it runs on.
  const record = await loopar.getDocument(entity, name);
  const allTitles = await record.linkTitles();
  const meta = await record.__meta__();
  const all = indexFields(parse(meta.Entity.doc_structure, []) || []);
  const values = meta.data || {};

  // Only what the format prints leaves the server: a snapshot travels to
  // whoever opens the copy, so unprinted fields (internal notes, costs…),
  // their labels and their links stay out of it.
  const structure = [];
  const data = {};
  const linkTitles = {};
  const keepTitle = (field, value) => {
    if (printKind(field.element, field.data) !== 'option' || isEmptyValue(value)) return;
    const linked = String(field.data?.options || '').split(/\r?\n/)[0].trim();
    for (const one of String(value).split(',').map((v) => v.trim())) {
      const title = allTitles?.[linked]?.[one];
      if (title != null) (linkTitles[linked] ??= {})[one] = title;
    }
  };

  const collect = (nodes) => (nodes || []).forEach((el) => {
    const field = el?.data?.field && all.get(el.data.field);
    if (field && el.element === 'doc_field' && field.element !== 'form_table') {
      structure.push({ element: field.element, data: field.data });
      data[el.data.field] = values[el.data.field];
      keepTitle(field, values[el.data.field]);
    } else if (field && el.element === 'doc_table' && field.element === 'form_table') {
      const columns = tableColumns(field, String(el.data.columns || '').split(',').map((c) => c.trim()).filter(Boolean));
      // The child entity, reduced to the printed columns (flagged so they stay the default ones).
      const child = columns.map((c) => ({ element: c.element, data: { ...c.data, in_list_view: 1 } }));
      structure.push({ element: field.element, data: field.data, __META__: { Entity: { doc_structure: JSON.stringify(child) } } });
      data[el.data.field] = (parse(values[el.data.field], []) || []).map((row) => {
        columns.forEach((c) => keepTitle(c, row[c.data.name]));
        return Object.fromEntries(columns.map((c) => [c.data.name, row[c.data.name]]));
      });
    }
    collect(el?.elements);
  });
  collect(parse(format.doc_structure, []) || []);

  return {
    v: 1,
    entity,
    name: record.name,
    format,
    structure: JSON.stringify(structure),
    data,
    linkTitles,
    letterhead,
    printed_at: new Date().toISOString(),
  };
}

const escapeHTML = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const parse = (value, fallback) => (value && typeof value === 'object') ? value : loopar.utils.JSONparse(value, fallback);
const humanize = (name) => loopar.utils.Capitalize(String(name || '').replaceAll('_', ' '));
const isWritable = (element) => elementsDict[element]?.def?.isWritable === true;
const multiline = (text) => escapeHTML(text).replace(/\r?\n/g, '<br>');

function indexFields(structure = []) {
  const map = new Map();
  const walk = (nodes) => (nodes || []).forEach((node) => {
    if (node?.data?.name && node.element) map.set(node.data.name, node);
    walk(node?.elements);
  });
  walk(structure);
  return map;
}

/** Columns of a child table: the listed names, else the child's list columns (as <PrintTable>). */
function tableColumns(node, names) {
  const fields = [];
  const walk = (nodes) => (nodes || []).forEach((n) => {
    if (!n?.element) return;
    if (isWritable(n.element)) {
      const kind = printKind(n.element, n.data);
      const hidden = truthy(n.data?.hidden) || truthy(n.data?.print_hide);
      if (n.data?.name && !hidden && !['skip', 'table', 'images', 'files', 'keyvalue', 'markdown'].includes(kind)) fields.push({ element: n.element, data: n.data, kind });
    } else walk(n.elements);
  });
  walk(parse(node.__META__?.Entity?.doc_structure, []) || []);

  if (names.length) {
    const byName = new Map(fields.map((f) => [f.data.name, f]));
    return names.map((n) => byName.get(n)).filter(Boolean);
  }
  const listed = fields.filter((f) => truthy(f.data.in_list_view));
  return listed.length ? listed : fields;
}

/**
 * The content of a snapshot as plain HTML (every value escaped): each label
 * and value the format prints, in its order, formatted like the sheet. No
 * layout — it is the readable, self-contained copy kept with a signature,
 * whatever the print components look like later.
 */
export function snapshotHTML(snapshot) {
  const fields = indexFields(parse(snapshot.structure, []) || []);
  const data = snapshot.data || {};
  const titles = snapshot.linkTitles || {};
  const lh = snapshot.letterhead;

  const valueOf = (node, value) => {
    const kind = printKind(node.element, node.data);
    if (['skip', 'images', 'files', 'table'].includes(kind)) return null;
    if (kind !== 'bool' && isEmptyValue(value)) return null;
    if (kind === 'keyvalue') {
      return (parse(value, []) || []).filter((r) => r && (r.name ?? r.label) != null)
        .map((r) => `${escapeHTML(r.name ?? r.label)}: ${escapeHTML(r.value ?? '')}`).join('<br>') || null;
    }
    if (kind === 'markdown') return multiline(value);
    const text = formatPrintValue(kind, value, { data: node.data, titles, currency: data.currency });
    return text == null ? null : multiline(text);
  };

  const render = (el) => {
    const d = el?.data || {};
    switch (el?.element) {
      case 'letterhead': {
        if (!lh) return '';
        if (d.part === 'footer') return lh.footer ? `<p><small>${multiline(lh.footer)}</small></p>` : '';
        const lines = [lh.tagline, lh.address, [lh.phone, lh.email, lh.website].filter(Boolean).join(' · ')].filter(Boolean);
        return `<p><strong>${escapeHTML(lh.company_name)}</strong>${lines.map((l) => `<br>${multiline(l)}`).join('')}</p>`;
      }
      case 'doc_header':
        return `<h1>${escapeHTML((d.title_field && data[d.title_field]) || d.label || snapshot.entity)}</h1><p>${escapeHTML(snapshot.name)} · ${escapeHTML(String(snapshot.printed_at).slice(0, 10))}</p>`;
      case 'doc_field': {
        const node = fields.get(d.field);
        if (truthy(d.hide_zero) && Number(data[d.field]) === 0) return '';
        const value = node && valueOf(node, data[d.field]);
        if (value == null) return '';
        const label = truthy(d.show_label ?? 1) ? `<strong>${escapeHTML(d.label || node.data?.label || humanize(d.field))}:</strong> ` : '';
        return `<p>${label}${value}</p>`;
      }
      case 'doc_table': {
        const node = fields.get(d.field);
        if (!node || node.element !== 'form_table') return '';
        const rows = parse(data[d.field], []) || [];
        const columns = tableColumns(node, String(d.columns || '').split(',').map((c) => c.trim()).filter(Boolean));
        if (!rows.length || !columns.length) return '';
        const label = d.label || node.data?.label;
        return `${label ? `<h2>${escapeHTML(label)}</h2>` : ''}<table><thead><tr>${columns.map((c) => `<th>${escapeHTML(c.data.label || humanize(c.data.name))}</th>`).join('')}</tr></thead><tbody>${
          rows.map((row) => `<tr>${columns.map((c) => `<td>${escapeHTML(formatPrintValue(c.kind, row[c.data.name], { data: c.data, titles, currency: data.currency }) ?? '')}</td>`).join('')}</tr>`).join('')
        }</tbody></table>`;
      }
      default: {
        const inner = (el?.elements || []).map(render).join('');
        const title = el?.element === 'doc_section' && d.label ? `<h2>${escapeHTML(d.label)}</h2>` : '';
        const text = !el?.elements?.length && typeof d.text === 'string' && d.text.trim() ? `<p>${multiline(d.text)}</p>` : '';
        return title + text + inner;
      }
    }
  };

  return `<section class="print-snapshot">${(parse(snapshot.format?.doc_structure, []) || []).map(render).join('')}</section>`;
}
